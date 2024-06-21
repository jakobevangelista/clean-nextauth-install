import { db } from "@/server/neonDb";
import { userAttributes, users } from "@/server/neonDb/schema";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { redirect } from "next/navigation";

export default async function Home() {
  const { userId }: { userId: string | null } = await auth();
  if (userId === null) {
    return redirect("/sign-in");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.email, session.user?.email!),
  });

  const userAttribute = await db.query.userAttributes.findFirst({
    where: eq(userAttributes.userId, user?.id!),
  });

  return (
    <>
      <div>Signed In with Next-Auth</div>
      <div>{JSON.stringify(session)}</div>
      <div>Special Attribute: {userAttribute?.attribute}</div>
      <form
        action={async () => {
          "use server";
          await signOut();
        }}
      >
        <button type="submit">Sign Out</button>
      </form>
    </>
  );
}
