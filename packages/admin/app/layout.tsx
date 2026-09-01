import type { ReactNode } from "react";

export const metadata = { title: "くりとみかん 記事パイプライン 管理画面" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: 960,
          margin: "0 auto",
          padding: 16,
          lineHeight: 1.7,
        }}
      >
        <header style={{ borderBottom: "1px solid #ddd", marginBottom: 16, paddingBottom: 8 }}>
          <strong>くりとみかん 記事パイプライン</strong>
          <nav style={{ display: "inline-block", marginLeft: 24 }}>
            <a href="/" style={{ marginRight: 16 }}>
              承認キュー
            </a>
            <a href="/keywords" style={{ marginRight: 16 }}>
              トピック提案
            </a>
            <a href="/strategy" style={{ marginRight: 16 }}>
              月次戦略
            </a>
            <a href="/bulk" style={{ marginRight: 16 }}>
              一括レビュー
            </a>
            <a href="/links" style={{ marginRight: 16 }}>
              内部リンク承認
            </a>
            <a href="/ops">運用 (トリップワイヤ/AI CV)</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
