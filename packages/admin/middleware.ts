// 暫定認証ゲート。
// 本認証はSupabase Auth (代表1ユーザ、メールリンク。SPEC M12) が本来の姿だが、
// デプロイ先ではVercel Authentication (SSO) が前段に入るため、実質は二重の保護になっている。
// ADMIN_ACCESS_TOKEN 設定時: ?token= で入場しcookieに保持。未設定時: developmentのみ許可。
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const token = process.env.ADMIN_ACCESS_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === "development") return NextResponse.next();
    return new NextResponse("ADMIN_ACCESS_TOKEN未設定のためブロックしています", { status: 401 });
  }
  const fromQuery = req.nextUrl.searchParams.get("token");
  const supplied = fromQuery ?? req.cookies.get("admin_token")?.value;
  if (supplied === token) {
    // トークン付きURLで入ったら、以降は素のURLで開けるようにcookieへ寄せる。
    // 承認は毎日の作業なので、都度トークンを貼らせない (スマホからの承認が現実的でなくなる)。
    // セッションcookieだとブラウザを閉じるたびに切れるため、明示的に90日持たせる。
    const res = fromQuery
      ? NextResponse.redirect(new URL(req.nextUrl.pathname + stripToken(req.nextUrl.search), req.url))
      : NextResponse.next();
    if (req.cookies.get("admin_token")?.value !== token) {
      res.cookies.set("admin_token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.nextUrl.protocol === "https:",
        path: "/",
        maxAge: 60 * 60 * 24 * 90,
      });
    }
    return res;
  }
  return new NextResponse("認証が必要です (?token=ADMIN_ACCESS_TOKEN)", { status: 401 });
}

// トークンをURLから外して履歴やブックマークに残さない
function stripToken(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("token");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export const config = { matcher: ["/((?!_next|favicon).*)"] };
