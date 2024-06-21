import { db } from "@/server/neonDb";
import { userAttributes, users } from "@/server/neonDb/schema";
import { UserButton } from "@clerk/nextjs";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { redirect } from "next/navigation";

export default async function Home() {
  const user = await currentUser();
  const { sessionClaims } = await auth();
  console.log("SESSION CLAIMS: ", sessionClaims);
  if (user === null) {
    return redirect("/sign-in");
  }

  const userAttribute = await db.query.userAttributes.findFirst({
    where: eq(userAttributes.userId, sessionClaims!.userId! as string),
  });

  return (
    <>
      <div>Special Attribute: {userAttribute?.attribute}</div>
      <UserButton />
    </>
  );
}
