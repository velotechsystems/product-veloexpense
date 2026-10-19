/**
 * Travel's budget buckets, named by `TravelCategory.code`.
 *
 * Codes rather than labels because a label is locale-keyed and editable — renaming "Airfare"
 * to "Flights" must not stop the lodging cap resolving or the drawer recognising the
 * rental-car bucket. A bucket whose category is absent simply produces nothing; the seed
 * ships all four.
 *
 * All that survives of `travelQuote.ts`, which held the bulk "get live prices" path until the
 * per-line pickers replaced it. That path auto-took the cheapest flight and stay, which is
 * exactly what a picker exists to let a traveller decide instead.
 */
export const TRAVEL_CATEGORY_CODES: Record<string, string> = {
  airfare: 'travelAirfare',
  lodging: 'travelHotel',
  meals: 'travelMeals',
  /**
   * Declared, and never quoted — deliberately, because nothing can quote it.
   *
   * SerpApi's travel surface is Google Flights, Google Hotels, Google Travel Explore,
   * TripAdvisor and OpenTable. There is no car-rental engine, and no Google car-rental
   * results page for one to scrape. Every real alternative — Booking.com Demand Cars,
   * Expedia Rapid Car, Avis or Hertz direct, Amadeus Enterprise — needs a commercial
   * agreement, so the blocker is procurement rather than code.
   *
   * A car is therefore a line the traveller adds against this category, priced from the
   * daily cap × the days of the trip, saying "no live rate available" rather than posing as
   * a quote. For an APPROVAL that is arguably the better number: a policy ceiling is what
   * the org decided, where a market rate is what one vendor quoted on one day.
   */
  car: 'travelCarRental',
};
