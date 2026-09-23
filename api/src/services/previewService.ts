import type { LinkRecord } from '../domain/types.js';
import { extractPreview, safeFetchHtml, type SafeFetchOptions } from '../lib/safeFetch.js';
import type { Store } from '../stores/types.js';

/**
 * Fetches a destination's title and favicon in the background after a link is
 * created or its URL changes. Bounded concurrency; failures are logged and
 * ignored (a preview is decoration, never a reason to fail a request).
 */
export class PreviewService {
  private active = 0;
  private waiting: LinkRecord[] = [];

  constructor(
    private readonly d: {
      store: Store;
      fetchOptions: SafeFetchOptions;
      now: () => Date;
      log?: { warn: (obj: unknown, msg: string) => void };
      concurrency?: number;
      fetchHtml?: typeof safeFetchHtml;
    },
  ) {}

  schedule(link: LinkRecord): void {
    if (this.waiting.length >= 200) return;
    this.waiting.push(link);
    this.pump();
  }

  private pump(): void {
    while (this.active < (this.d.concurrency ?? 4) && this.waiting.length) {
      const link = this.waiting.shift()!;
      this.active++;
      void this.run(link).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  async run(link: LinkRecord): Promise<void> {
    try {
      const page = await (this.d.fetchHtml ?? safeFetchHtml)(link.url, this.d.fetchOptions);
      const preview = extractPreview(page.html, page.finalUrl);
      await this.d.store.updateLink(link.id, { title: preview.title, faviconUrl: preview.faviconUrl }, this.d.now());
    } catch (err) {
      this.d.log?.warn({ err: (err as Error).message, linkId: link.id }, 'link preview skipped');
    }
  }
}
