"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh">
      <body className="antialiased flex items-center justify-center min-h-screen bg-background text-foreground">
        <div className="text-center max-w-md px-6">
          <h2 className="text-lg font-semibold mb-2">出错了</h2>
          <p className="text-sm text-muted-foreground mb-4">
            发生了一个意外错误，请重试。
          </p>
          <button
            onClick={reset}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            重试
          </button>
        </div>
      </body>
    </html>
  );
}
