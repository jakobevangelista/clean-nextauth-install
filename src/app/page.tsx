import { db } from "@/server/neonDb";
import { userAttributes, users } from "@/server/neonDb/schema";
import { UserButton } from "@clerk/nextjs";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { redirect } from "next/navigation";

export default async function Home() {
  const user = await currentUser();
  if (user === null) {
    return redirect("/sign-in");
  }

  const dbUser = await db.query.users.findFirst({
    where: eq(users.email, user.emailAddresses[0]?.emailAddress!),
  });

  const userAttribute = await db.query.userAttributes.findFirst({
    where: eq(userAttributes.userId, dbUser?.id!),
  });

  return (
    <>
      <div>Special Attribute: {userAttribute?.attribute}</div>
      <UserButton />
    </>
  );
}
