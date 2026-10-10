/**
 * Google Maps Platform access for mileage — address search and driving distance.
 *
 * Everything here runs SERVER-SIDE. The API key never reaches the browser: a
 * key in client JavaScript is a key anyone can lift and spend, and Maps Platform
 * bills per request.
 *
 * Two APIs, for two different jobs:
 *   · Places Autocomplete (New) turns what someone is typing into address
 *     suggestions. Billed per session, so the caller passes a session token that
 *     ties the keystrokes and the eventual selection into one billable unit.
 *   · Routes API computes the driving distance across the ordered stops. Called
 *     once, when the route is complete — not per keystroke.
 *
 * ON STORING RESULTS. The Maps Platform terms restrict retaining place data.
 * `placeId` is the durable handle and may be kept; the descriptive fields are
 * cached only as a display convenience on the line item's route snapshot, which
 * a filed expense needs in order to stand as filed. Worth a legal read before
 * this is switched on — see the note on the PR.
 *
 * VeloExpense: ported from ExpenseOS (550b2945) for w2-10. One difference, in
 * `getMapsConfig`: the key comes from the environment only. ExpenseOS reads an installed
 * `google-maps` integration first; VeloExpense's integrations carry ledgers alone until its
 * integrations screen is ported, so there is no installation to read. With no key the
 * answer is null and the mileage form takes typed addresses and a typed distance, as
 * ExpenseOS's does.
 */

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:autocomplete';
const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
/** Give up rather than hold a request open — a slow map lookup must not wedge
 *  the expense form. */
const TIMEOUT_MS = 6_000;

export interface MapsConfig {
  apiKey: string;
  region?: string;
}

export interface PlaceSuggestion {
  /** The durable handle. Safe to retain. */
  placeId: string;
  /** "Bloor St W, Toronto, ON, Canada" — display only. */
  description: string;
}

export interface RouteLeg {
  fromPlaceId: string;
  toPlaceId: string;
  /** Metres, as returned. */
  meters: number;
}

export interface RouteResult {
  legs: RouteLeg[];
  totalMeters: number;
}

/** VeloExpense: kept for ExpenseOS's call sites (`getMapsConfig(ctx.db)`); not read. */
type Db = unknown;

/**
 * The active installation's config, else the environment, else null.
 *
 * Null is a first-class answer, not an error: the mileage form falls back to
 * typed addresses and a manually entered distance, so the feature ships before
 * anyone has procured a key.
 *
 * Precedence is installation-then-env, the same order and for the same reasons as
 * `resolveAnthropicConfig` in @expenseos/db. The installation is the source of truth
 * because rotating the key in the admin UI has to beat whatever a stale task definition
 * exported, or saving there would appear to do nothing. The environment stays a FALLBACK
 * rather than the mechanism because a developer and CI have a GOOGLE_PLACES_API_KEY and
 * no installation row — and without the fallback the city picker reports itself
 * unavailable there while offering no clue why.
 */
export async function getMapsConfig(
  _db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MapsConfig | null> {
  // VeloExpense: no installation to read yet — see the file header. ExpenseOS's
  // installation branch (key and region off the active `google-maps` installation,
  // decrypted) arrives with the integrations screen.

  const apiKey = env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) return null;
  // No region alongside it. Restricting results is an admin decision that belongs on the
  // installation next to the key, and a restriction nobody asked for is how every city
  // outside one country becomes unfindable.
  return { apiKey };
}

/**
 * What to actually DO about a Google rejection.
 *
 * Google's messages are accurate and unactionable: "Requests to this API ...
 * method google.maps.places.v1.Places.AutocompletePlaces are blocked" is precisely
 * true and tells you nothing about which of four console settings to change. Every
 * one of these was diagnosed by hand once; the point of putting them here is that
 * nobody has to do it twice.
 *
 * Matched on the message text rather than a status code because Google reuses 403
 * for four unrelated causes, and the wording is the only thing that separates them.
 */
export function mapsRemedy(status: number, body: string): string | null {
  const text = `${body}`.toLowerCase();

  // API_KEY_SERVICE_BLOCKED — the key is real, the project just won't let it call
  // this method. Almost always the key's "API restrictions" list.
  if (text.includes('are blocked') && text.includes('method')) {
    return (
      'The key is valid but not allowed to call this API. In Google Cloud Console → ' +
      'Credentials → this key → API restrictions, add "Places API (New)" and "Routes API". ' +
      'Note that "Places API" and "Places API (New)" are SEPARATE entries — a key allowed ' +
      'only the legacy one is blocked for autocomplete.'
    );
  }
  // SERVICE_DISABLED — the API was never turned on for the project.
  if (text.includes('has not been used in project') || text.includes('service_disabled')) {
    return 'Enable "Places API (New)" and "Routes API" on the project (APIs & Services → Enabled APIs).';
  }
  // Application restrictions. A server-side call sends no referrer, so a
  // referrer-restricted key can never work here.
  if (text.includes('referer') || text.includes('referrer')) {
    return (
      'This key is restricted by HTTP referrer, which a server-side call cannot satisfy — ' +
      'these requests are made from the container, not the browser. Set Application ' +
      "restrictions to None, or to the egress IP (on AWS, the NAT gateway's Elastic IP)."
    );
  }
  if (text.includes('ip address') || text.includes('ip_address')) {
    return (
      'This key is restricted to specific IP addresses and the caller is not one of them. ' +
      "On AWS the address to allow is the NAT gateway's Elastic IP — tasks egress through " +
      'it, not from their own address.'
    );
  }
  if (text.includes('api key not valid') || text.includes('api_key_invalid')) {
    return 'The key itself was rejected — check it was pasted whole and belongs to this project.';
  }
  if (text.includes('billing')) {
    return 'Billing is not enabled on the project. Maps Platform bills per request and refuses to serve without it.';
  }
  if (status === 429 || text.includes('quota')) {
    return 'The project is over its quota for this API. Raise the quota or wait for the window to reset.';
  }
  return null;
}

async function post(url: string, apiKey: string, fieldMask: string | null, body: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // Routes REQUIRES a field mask and bills by what you ask for, so asking
        // for less costs less. Autocomplete (New) does NOT take one — it returns
        // a fixed prediction shape — and sending the header there is rejected.
        // Hence nullable rather than always-on.
        ...(fieldMask ? { 'X-Goog-FieldMask': fieldMask } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Log the endpoint + outgoing body on the server (the key rides in a header,
      // never the body) so a rejected request is diagnosable from the logs rather
      // than from guesswork.
      console.error(
        `[googleMaps] ${url} rejected: HTTP ${res.status} · req=${JSON.stringify(body)} · res=${text.slice(0, 2000)}`,
      );
      // Google's reason, then what to do about it. The reason alone is what sent
      // somebody into the console guessing which of four settings was wrong.
      const reason = googleMessage(text) ?? text.slice(0, 300);
      const remedy = mapsRemedy(res.status, text);
      throw new Error(`Google Maps ${res.status}: ${reason}${remedy ? ` — ${remedy}` : ''}`);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Address suggestions for a partial query.
 *
 * `sessionToken` should be a UUID the client keeps for one "pick an address"
 * interaction and discards after the selection — that's what makes the whole
 * sequence bill as one autocomplete session instead of per keystroke.
 */
export async function searchPlaces(
  cfg: MapsConfig,
  query: string,
  sessionToken: string,
): Promise<PlaceSuggestion[]> {
  const regions = regionCodes(cfg.region);
  const json = await post(PLACES_ENDPOINT, cfg.apiKey, null, {
    input: query,
    sessionToken,
    // `includedRegionCodes` RESTRICTS — it does not merely bias. One code here
    // means addresses anywhere else return nothing at all, which is why this
    // takes a LIST: a company with Canadian and US employees needs both, and a
    // lone "CA" silently made every US address unfindable. Empty = no restriction.
    ...(regions.length > 0 ? { includedRegionCodes: regions } : {}),
  });
  const suggestions = (json.suggestions ?? []) as Array<{
    placePrediction?: { placeId?: string; text?: { text?: string } };
  }>;
  return suggestions
    .map((s) => ({
      placeId: s.placePrediction?.placeId ?? '',
      description: s.placePrediction?.text?.text ?? '',
    }))
    .filter((s) => s.placeId && s.description);
}

export interface CitySuggestion extends PlaceSuggestion {
  /** "Toronto" — matched against a PerDiemRate's city and used as the hotel query. */
  city: string;
  /** "Canada", as Google renders it in the user's language. */
  country: string | null;
}

/**
 * City suggestions for a travel destination.
 *
 * Restricted to localities, which is the whole point: you fly to a city, not to a
 * street address. It also solves the field problem — per-diem matches on a city and
 * the hotel search takes one, and picking "123 Bloor St W, Toronto, ON, Canada"
 * gives neither without a second (billable) Place Details call.
 *
 * `structuredFormat` splits the answer for us: mainText is the city, secondaryText
 * is "ON, Canada", whose last segment is the country. Parsing the flat description
 * instead would need to know how many administrative levels a country has.
 */
export async function searchCities(
  cfg: MapsConfig,
  query: string,
  sessionToken: string,
): Promise<CitySuggestion[]> {
  const regions = regionCodes(cfg.region);
  const json = await post(PLACES_ENDPOINT, cfg.apiKey, null, {
    input: query,
    sessionToken,
    // `locality` alone misses places Google files one level down (a lot of
    // European towns), so the coarser administrative level is included too.
    includedPrimaryTypes: ['locality', 'administrative_area_level_3'],
    ...(regions.length > 0 ? { includedRegionCodes: regions } : {}),
  });
  const suggestions = (json.suggestions ?? []) as Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
    };
  }>;
  return suggestions
    .map((s) => {
      const p = s.placePrediction;
      const description = p?.text?.text ?? '';
      const city = p?.structuredFormat?.mainText?.text ?? description.split(',')[0]?.trim() ?? '';
      const secondary = p?.structuredFormat?.secondaryText?.text ?? '';
      const parts = secondary
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      return {
        placeId: p?.placeId ?? '',
        description,
        city,
        country: parts.length > 0 ? parts[parts.length - 1] : null,
      };
    })
    .filter((s) => s.placeId && s.city);
}

/**
 * Driving distance across `placeIds` in order, leg by leg.
 *
 * Legs rather than a single total because a route the traveller can check is a
 * route they can correct — and an auditor looking at a 340 km claim wants to see
 * which hop accounts for it.
 *
 * Intermediate stops are passed in order and NOT optimized: the traveller drove
 * the route they drove, and reordering it to be shorter would change the claim.
 */
/**
 * Region codes as the Places API wants them: lowercase CLDR two-letter codes.
 *
 * Accepts the comma/space-separated list an admin types ("CA, US") because the
 * field restricts results and one country is rarely the honest answer. Anything
 * that isn't two letters is dropped rather than sent — a malformed code makes the
 * whole request fail, taking every valid one with it.
 */
export function regionCodes(region: string | undefined): string[] {
  if (!region) return [];
  return [
    ...new Set(
      region
        .split(/[\s,;]+/)
        .map((c) => c.trim().toLowerCase())
        .filter((c) => /^[a-z]{2}$/.test(c)),
    ),
  ].slice(0, 15);
}

/** Google's error envelope carries the real reason in `error.message`; the rest
 *  of the body is the request echoed back. */
export function googleMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === 'string' && message.trim() ? message.slice(0, 300) : null;
  } catch {
    return null;
  }
}

export async function computeRoute(
  cfg: MapsConfig,
  placeIds: readonly string[],
): Promise<RouteResult> {
  if (placeIds.length < 2) return { legs: [], totalMeters: 0 };

  const json = await post(ROUTES_ENDPOINT, cfg.apiKey, 'routes.legs.distanceMeters', {
    origin: { placeId: placeIds[0] },
    destination: { placeId: placeIds[placeIds.length - 1] },
    ...(placeIds.length > 2
      ? { intermediates: placeIds.slice(1, -1).map((placeId) => ({ placeId })) }
      : {}),
    travelMode: 'DRIVE',
    // Distance is what a mileage claim is about; a traffic-aware duration would
    // make the same route return a different answer every time it's recomputed.
    routingPreference: 'TRAFFIC_UNAWARE',
    optimizeWaypointOrder: false,
  });

  const route = ((json.routes ?? []) as Array<{ legs?: Array<{ distanceMeters?: number }> }>)[0];
  const rawLegs = route?.legs ?? [];
  const legs: RouteLeg[] = rawLegs.map((leg, i) => ({
    fromPlaceId: placeIds[i] ?? '',
    toPlaceId: placeIds[i + 1] ?? '',
    meters: leg.distanceMeters ?? 0,
  }));
  return { legs, totalMeters: legs.reduce((a, l) => a + l.meters, 0) };
}

/** Metres → a "123.45" distance string in the requested unit. */
export function metersToDistance(meters: number, unit: 'KM' | 'MI'): string {
  const value = unit === 'MI' ? meters / 1609.344 : meters / 1000;
  return value.toFixed(2);
}
