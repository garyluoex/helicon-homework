import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verify } from "@/lib/session";

export async function middleware(request: NextRequest) {
  if (await verify(request.cookies.get(COOKIE_NAME)?.value)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

// Everything except the login screen, Next's own assets and the favicon.
export const config = { matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"] };
