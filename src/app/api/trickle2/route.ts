import { db } from "@/server/neonDb";
import { users } from "@/server/neonDb/schema";
import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import type { NextRequest, NextResponse } from "next/server";

export const POST = async (req: NextRequest, res: NextResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const body = await req.json();
  console.log("REQ BODY: ", body);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const onlyEmail = decodeURIComponent(body.email.split("=")[1]);
  const user = await db.query.users.findFirst({
    where: eq(users.email, onlyEmail),
  });
  if (!user) {
    return Response.json({ error: "not exist" });
  }

  await clerkClient.users.createUser({
    emailAddress: [onlyEmail],
    password: user.password ?? undefined,
    skipPasswordChecks: true,
    externalId: `${user.id}`,
  });

  return Response.json({ succes: "user exists" });
};
