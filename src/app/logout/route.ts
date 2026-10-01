import { NextResponse, type NextRequest } from "next/server";
import { logout } from "@/modules/auth/session";

/**
 * Form-friendly logout for server-rendered pages. The JSON API route at
 * /api/auth/logout serves programmatic clients; this one exists so the
 * layout's plain <form method="post"> works without any client JS, and
 * returns the user to the landing page via a 303 redirect.
 */
export async function POST(request: NextRequest) {
  await logout();
  return NextResponse.redirect(new URL("/", request.url), 303);
}
