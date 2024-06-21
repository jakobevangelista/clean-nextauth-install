import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

export default async function SignInComponent() {
  const { userId }: { userId: string | null } = await auth();
  if (userId === null) {
    return (
      <>
        <SignIn />
      </>
    );
  }

  return redirect("/");
}
