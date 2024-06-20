"use client";
import { SignIn, useUser } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { useEffect } from "react";

export default function SignInComponent() {
  //   const session = await auth();
  const { user } = useUser();
  useEffect(() => {
    const origFetch = window.fetch;
    window.fetch = async function (url, init) {
      const originalRes = await origFetch(url, init);

      if (originalRes.status === 422) {
        const res = await fetch("/api/trickle2", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: init?.body,
          }),
        });

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const data = await res.json();

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (data.error === "not exist") {
          return originalRes;
        } else {
          const retry = await origFetch(url, init);
          return retry;
        }
      }

      return originalRes;
    };
    return () => {
      window.fetch = origFetch;
    };
  });
  if (user === null || user === undefined) {
    return (
      <>
        <SignIn forceRedirectUrl={"/"} />
      </>
    );
  }

  return redirect("/");
}
