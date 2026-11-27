import { WarningCircle } from '@phosphor-icons/react';
import { useState } from 'react';

import { Spinner } from '@/components/ui/spinner';

interface MediaPaneProps {
  /** Where the file streams from, as a preview URL, or null while it's on its way. */
  url: string | null;
  kind: 'audio' | 'video';
  fileName: string;
  loading?: boolean;
  error?: string | null;
}

export function MediaPane({ url, kind, fileName, loading = false, error = null }: MediaPaneProps) {
  // A stream can fail after it starts, as when its SSH host goes away mid-file.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = url !== null && url === failedUrl;
  if (!url || failed) {
    const shownError = error ?? (failed ? `Couldn't play this ${kind}` : null);
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-8">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <div className="text-sm font-medium text-foreground">{fileName}</div>
          <div className="text-xs text-muted-foreground">
            {kind === 'audio' ? 'Audio' : 'Video'}
          </div>
          {shownError && (
            <div className="flex items-center gap-1.5 text-xs text-error">
              <WarningCircle className="size-4" />
              <span>{shownError}</span>
            </div>
          )}
          {loading && <Spinner />}
        </div>
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-8">
        <audio controls className="w-full max-w-2xl" src={url} onError={() => setFailedUrl(url)}>
          <track kind="captions" />
        </audio>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        controls
        className="max-h-full max-w-full"
        src={url}
        title={fileName}
        onError={() => setFailedUrl(url)}
      >
        <track kind="captions" />
      </video>
    </div>
  );
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
