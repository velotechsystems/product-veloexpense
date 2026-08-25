'use client';
/**
 * VX1-6 — the receipt drawer. The ONE client-JS surface in the workbench.
 *
 * It has to be: VX1-5 keeps bytes out of Next entirely, so the browser itself
 * performs the three-step upload —
 *   1. createUploadIntent()  → a PENDING row + a presigned PUT
 *   2. fetch(url, {PUT})     → straight to S3/MinIO
 *   3. confirmUpload()       → the server HEADs the object and records the real size
 * — which no <form action={serverAction}> can express.
 *
 * If step 2 fails with a network/CORS error, the bucket is almost certainly
 * missing a CORS rule allowing PUT from the app origin; that is called out in
 * the message rather than left as "Failed to fetch", because every server-side
 * test passes in that state.
 *
 * Constants come from lib/receipts/constants (not the service, which imports pg).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { MAX_RECEIPT_BYTES, RECEIPT_ACCEPT, formatBytes } from '@/lib/receipts/constants';
import {
  attachReceipt,
  confirmUpload,
  createUploadIntent,
  detachReceipt,
  getReceiptDownloadUrl,
  removeReceipt,
} from '@/app/receipts/actions';

export interface ReceiptSummary {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number | null;
}

export function ReceiptDrawer({
  expenseId,
  label,
  receipts,
  inbox,
  editable,
}: {
  expenseId: string;
  label: string;
  receipts: ReceiptSummary[];
  inbox: ReceiptSummary[];
  editable: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = async (work: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    await run(async () => {
      if (file.size > MAX_RECEIPT_BYTES) {
        throw new Error(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_RECEIPT_BYTES)}`);
      }
      const contentType = file.type || 'application/octet-stream';
      const intent = await createUploadIntent({ filename: file.name, contentType, expenseId });
      let response: Response;
      try {
        response = await fetch(intent.upload.url, {
          method: 'PUT',
          headers: intent.upload.headers,
          body: file,
        });
      } catch {
        throw new Error(
          'The browser could not reach object storage. Check that the bucket allows PUT from this origin (CORS).',
        );
      }
      if (!response.ok) throw new Error(`Storage rejected the upload (HTTP ${response.status}).`);
      await confirmUpload(intent.receipt.id);
    });
  };

  const openReceipt = async (receiptId: string) => {
    // Opened synchronously so the popup blocker sees a user gesture; the signed
    // URL is filled in when it arrives.
    const tab = window.open('', '_blank');
    try {
      const url = await getReceiptDownloadUrl(receiptId);
      if (tab) tab.location.href = url;
      // No tab to fill (blocked): navigate this one instead of losing the URL.
      else window.location.assign(url);
    } catch (err) {
      tab?.close();
      setError(err instanceof Error ? err.message : 'Could not open the receipt');
    }
  };

  const working = busy || pending;

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Receipts ({receipts.length})
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button
            type="button"
            aria-label="Close receipts"
            className="flex-1 bg-foreground/20"
            onClick={() => setOpen(false)}
          />
          <aside className="flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-border bg-background p-5 shadow-lg">
            <header className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold tracking-tight">Receipts</h2>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </header>

            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}

            {editable ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Add a receipt</span>
                <input
                  type="file"
                  accept={RECEIPT_ACCEPT}
                  disabled={working}
                  className="text-sm file:mr-3 file:rounded-lg file:border file:border-input file:bg-transparent file:px-2.5 file:py-1 file:text-sm"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    void onPick(file);
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  Images or PDF, up to {formatBytes(MAX_RECEIPT_BYTES)}. Uploads go straight to
                  storage — the file never passes through the app.
                </span>
              </label>
            ) : null}

            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Attached
              </h3>
              {receipts.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing attached to this expense yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {receipts.map((receipt) => (
                    <li
                      key={receipt.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{receipt.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatBytes(receipt.size_bytes)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={working}
                          onClick={() => void openReceipt(receipt.id)}
                        >
                          Open
                        </Button>
                        {editable ? (
                          <>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={working}
                              onClick={() => void run(() => detachReceipt(receipt.id).then(() => {}))}
                            >
                              Detach
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="destructive"
                              disabled={working}
                              onClick={() => void run(() => removeReceipt(receipt.id))}
                            >
                              Delete
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {editable ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Your unattached receipts
                </h3>
                {inbox.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing waiting. Receipts you upload without an expense land here.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {inbox.map((receipt) => (
                      <li
                        key={receipt.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm">{receipt.filename}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatBytes(receipt.size_bytes)}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={working}
                          onClick={() =>
                            void run(() => attachReceipt(receipt.id, expenseId).then(() => {}))
                          }
                        >
                          Attach
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {working ? <p className="text-xs text-muted-foreground">Working…</p> : null}
          </aside>
        </div>
      ) : null}
    </>
  );
}
