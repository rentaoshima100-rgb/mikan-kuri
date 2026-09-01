"use client";

// 承認ボタンは「本文を最後まで表示した」場合にのみ有効になる。
// v3では承認=全文レビューであり、それが記事に付く監修表記の根拠になるため、
// 読まずに押せる承認ボタンを置かない。
//
// 判定は本文末尾に置いたセンチネルが一度でも画面に入ったかどうか。
// 画面が大きく本文全体が最初から見えている場合は即座に有効になる。
import { useEffect, useRef, useState, type ReactNode } from "react";

export function ApproveGate({ children }: { children: ReactNode }) {
  const [readToEnd, setReadToEnd] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    // IntersectionObserver が使えない環境ではゲートを外す (承認できなくなるのを避ける)
    if (typeof IntersectionObserver === "undefined") {
      setReadToEnd(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setReadToEnd(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinel} aria-hidden style={{ height: 1 }} />
      {readToEnd ? (
        children
      ) : (
        <p
          style={{
            padding: 12,
            border: "1px dashed #bbb",
            borderRadius: 6,
            color: "#666",
            fontSize: 14,
          }}
        >
          本文を最後までご確認ください。読み終えると承認ボタンが表示されます
          (差し戻しは下のボタンからいつでも行えます)。
        </p>
      )}
    </>
  );
}
