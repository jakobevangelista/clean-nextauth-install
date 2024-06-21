# Migration Guide: Moving from Next-Auth to Clerk 

## Introduction

Migrating from Next-Auth to Clerk can be daunting, but this guide aims to help you achieve a seamless transition with zero downtime. This guide covers running both middlewares simultaneously, importing users while keeping your application active, and ensuring a smooth experience for your users.

## Prerequisites

Before you begin, ensure you have the following:

- An active Clerk account.
- Your current application using Next-Auth.
- Access to your user database.
(We're assuming all user data outside of user name, email, and password are stored in a tenet table (ie user_attribute table) with a foreign key that is the next-auth user primary key)

## Migration Overview

To ensure a smooth migration with minimal disruption to your users, we will follow these steps:
1. **Batch Import Existing Users**
2. **Add Clerk Middleware and Nest Next-Auth Middleware**
3. **Implement Trickle Migration**
4. **Implement Sign-up and Sign-in with Clerk**
5. **Switch Data Access Patterns to Clerk**
6. **Turn off all next-auth things and switch to clerk**

## Migration Steps

### 1. Batch Import

The batch import handles the migration of all users through a scheduled process, ensuring all users are migrated without overwhelming the system and hitting the rate limit (20req/10sec). We do this by limiting batch importing to 15req/10sec to allow the trickle migration to have some for its processing. (After v1, we want this to go as fast as possible with an exponential backoff in order to not have to manually keep track)

#### Script to get all users in existing database within a queue

Store all users in a queue for batch processing. This can be done using a standalone nodejs script. The implementation uses nextjs app router's server components. 

The process is just iterating through all the users, storing them in a queue for the cron job to process individually. Definitely scaling concerns but you can modify this solution to fit your scale.

As with the trickle migration, along with creating the user in clerk, we also want to update the user attribute table associated with the migrated user.

```js
// src/app/batch/page.tsx
import { db } from "@/server/db";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default function Batch() {
  async function buttonPress() {
    "use server";
    const users = await db.query.users.findMany();

    for (const user of users) {
      await redis.rpush("email", user.email);
      await redis.rpush("password", user.password ?? "null");
      await redis.rpush("id", user.id);
      console.log("IMPORTED: ", user.email);
    }
  }
  return (
    <>
      <form action={buttonPress}>
        <button>Press me</button>
      </form>
    </>
  );
}
```

#### Backend API for Batch Import to import users into Clerk

Use a cron job to process the queue and create users in Clerk, respecting rate limits. Using Upstash for the cron job running but you can use any job runner of your choice. Again, does not have to be in nextjs, can be any express-like backend. 

```js
// src/app/api/batch/route.ts

import { clerkClient } from "@clerk/nextjs/server";
import { Receiver } from "@upstash/qstash";
import { Redis } from "@upstash/redis";
import { headers } from "next/headers";

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function POST() {
  const headersList = headers();
  const signature = headersList.get("Upstash-Signature");

  if (!signature) {
    return new Response("No signature", { status: 401 });
  }

  const isValid = await receiver.verify({
    body: "",
    signature,
    url: process.env.WEBHOOK_URL!,
  });

  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const lengthOfQueue = await redis.llen("key");
  const lengthOfLoop = lengthOfQueue > 20 ? 20 : lengthOfQueue;
  for (let i = 0; i < lengthOfLoop; i++) {
    const email = await redis.lpop<string | null>("email");
    const password = await redis.lpop<string | null>("password");
    const id = await redis.lpop<string>("id");
    if (!email) break;

    const searchUser = await clerkClient.users.getUserList({ emailAddress: [email] });

    if (searchUser.data.length > 0) {
      continue;
    } else {
      const createdUser = await clerkClient.users.createUser({
        emailAddress: [email],
        password: password === "null" ? undefined : password!,
        externalId: id!,
        skipPasswordRequirement: true,
        skipPasswordChecks: true,
      });

      // updates the user's attribute table entry with their clerk id
      await db.update(userAttributes).set({
      clerkId: createdUser.id
      }).where(eq(userAttributes.userId, createdUser.externalId));
    }
  }
  console.log("BATCH IMPORTING WORKS");
  return new Response("OK", { status: 200 });
}
```

### 2. Add Clerk Middleware

We need Clerk's middleware in order to use useSign in.

First, add the Clerk middleware alongside the existing NextAuth middleware. Clerk middleware has to be the top wrapper for the entire middleware. In the example provided, we put a sample middleware functions within the next auth middleware, you can switch this with whatever middleware custom middleware functions you have.


```js
// src/app/middleware.ts

import NextAuth from "next-auth";
import authConfig from "@/auth.config";
import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const { auth } = NextAuth(authConfig);
const nextAuthMiddle = auth(function middleware(req) {
  // custom middleware functions here
});

export default clerkMiddleware(async (clerkauth, req) => {
  console.log("MIDDLE WARE WORK CLERK");
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  await nextAuthMiddle(req); // works but needs AppRouteHandlerFnContext
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
```
### 3. Trickle Migration

<!-- Users need to add clerkprovider in order for this to work so we can somehow fit it into the docs later -->

Use the following code to create users in Clerk and sign them in, this auto signs users in that were previously signed into nextauth allowing zero-downtime sign in:

#### Server-Side

Create a server-side function that checks if the current NextAuth user exists in Clerk. If not, create the user in Clerk, generate a sign-in token, and pass it to the frontend. This implementation uses Nextjs App router's server component, but you can do this traditionally by making this an api endpoint that you call from the frontend.

We are using the "external_id" attribute within the createUser function. This allows users to have a tenet table to store all user attributes outside of clerk in their own user table.

We query the tenet table and pass the data to the children as an example of how to use the external_id function.

Along with creating the user in clerk, we also want to update the user attribute table associated with the migrated user.

(As noted in batch, eventually we want this to be able to fail in order to get maximum speedup, because with the v1, we're just hoping for 5req/10sec would be enough)


```js
// src/app/_components/migrationComponent.tsx
import { auth } from "@/auth";
import { db } from "@/server/neonDb";
import { users } from "@/server/neonDb/schema";
import { auth as clerkAuthFunction, clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import ClientClerkcomponent from "./clientClerkComponent";

export default async function MigrationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const { userId }: { userId: string | null } = clerkAuthFunction();
  if (userId) return <>{children}</>;
  if (!session?.user) return <>{children}</>;

  // checks for user email already existing (inserted from batch import)
  const searchUser = await clerkClient.users.getUserList({
    emailAddress: [session.user.email!],
  });

  let createdUser = null;

  if (searchUser.data.length > 0) {
    createdUser = searchUser.data[0];
  } else {
    if (!session.user.email) return <div>Failed to create user in clerk</div>;
    const user = await db.query.users.findFirst({
      where: eq(users.email, session.user.email),
    });

    if (!user) return <div>Failed to find user create user in db</div>;
    // creates user in clerk, with password if it exists, and externalId as the user id
    // to access tenet table attributes
    createdUser = await clerkClient.users.createUser({
      emailAddress: [session.user.email],
      password: user.password ?? undefined,
      skipPasswordChecks: true,
      externalId: `${user.id}`,
    });
  }

  if (!createdUser) return <div>Failed to create user</div>;

  // updates the user's attribute table entry with their clerk id
  await db.update(userAttributes).set({
    clerkId: createdUser.id
  }).where(eq(userAttributes.userId, createdUser.externalId));

  // creates sign in token for user
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const signInToken: { token: string } = await fetch(
    "https://api.clerk.com/v1/sign_in_tokens",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      },
      body: JSON.stringify({
        user_id: createdUser.id,
      }),
    }
  ).then(async (res) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return await res.json();
  });

  if (!signInToken.token) return <div>Failed to create sign in token</div>;

  return (
    <>
      <ClientClerkcomponent sessionId={signInToken.token} />
      {children}
    </>
  );
}

```

#### Client Side Component

On the frontend, use the token to sign the user into Clerk seamlessly.

We also display the information retrieved from the tenet table.


```js
// src/app/_components/clientClerkComponent.tsx

"use client";

import { useSignIn, useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";

interface ClientClerkComponentProps {
  sessionId: string;
}

export default function ClientClerkComponent({
  sessionId,
}: ClientClerkComponentProps) {
  const { signIn, setActive } = useSignIn();
  const { user } = useUser();
  const [signInProcessed, setSignInProcessed] = useState<boolean>(false);

  useEffect(() => {
    // magic link method to sign in using token
    // instead of passing to url, passed from server
    if (!signIn || !setActive || !sessionId) {
      return;
    }

    const createSignIn = async () => {
      try {
        const res = await signIn.create({
          strategy: "ticket",
          ticket: sessionId,
        });

        console.log("RES: ", res);
        await setActive({
          session: res.createdSessionId,
          beforeEmit: () => setSignInProcessed(true),
        });
      } catch (err) {
        setSignInProcessed(true);
      }
    };

    void createSignIn();
  }, [signIn, setActive, sessionId]);

  if (!sessionId) {
    return <div>no token provided</div>;
  }

  if (!signInProcessed) {
    return <div>loading</div>;
  }

  if (!user) {
    return <div>error invalid token {sessionId}</div>;
  }

  return (
    <>
      <div>Signed in as {user.id}</div>
    </>
  );
}
```

### 4. Wrap Application in &lt;ClerkProvider> and &lt;MigrationLayout>

Wrap your application layout in the &lt;ClerkProvider> component to enable Clerk authentication. Also wrap the &lt;MigrationLayout> component, this allows users that are already signed into next-auth to seamlessly sign into clerk.

```js
// src/app/layout.tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import MigrationLayout from "./_components/migrationComponent";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Create Next App",
  description: "Generated by create next app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={inter.className}>
          <MigrationLayout>{children}</MigrationLayout>
        </body>
      </html>
    </ClerkProvider>
  );
}
```

### 5. Sign-Ups and Sign-Ins go through the clerk components

New user sign ups go through the clerk components

```js
// src/app/sign-up/[[...sign-up]]/page.tsx
import { SignUp } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";

import { redirect } from "next/navigation";

export default async function SignUpComponent() {
  const { userId }: { userId: string | null } = await auth();
  if (userId === null) {
    return (
      <>
        <SignUp forceRedirectUrl={"/"} />
      </>
    );
  }

  return redirect("/");
}

// src/app/sign-in/[[...sign-i]]/page.tsx
import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";

import { redirect } from "next/navigation";

export default async function SignInComponent() {
  const { userId }: { userId: string | null } = await auth();
  if (userId === null) {
    return (
      <>
        <SignIn forceRedirectUrl={"/"} />
      </>
    );
  }

  return redirect("/");
}
```
### 6. Migrate Data Access Patterns (/src/app/page.tsx)

<!-- need to implement code example with diffs graphic -->

Update all data access patterns to use Clerk's auth() instead of NextAuth's auth(). While the migration is happening, we will use the external_id from clerk in order to retrieve data.

```diff
- import { auth } from "@/auth";
+ import { auth } from "@clerk/nextjs/server"

-  const session = await auth();
-  if (!session) return <div>Not Signed In</div>;

+ const { userId } : { userId: string | null } = await auth();
+ if (!userId) <div>Not Signed In</div>;

or

+ import { currentUser } from "@clerk/nextjs/server"
+ const user = await currentUser();
+ if(!user) <div>Not Signed In </div>;

```

#### Add clerkid attribute to tenet table

Add add a clerkId attribute to your user_attributes table, this allows you to use both the next-auth id, which is stored in external_id in clerk, or clerk id during migration, and eventually transition to only using clerkid.

```diff
export const userAttributes = pgTable("user_attribute", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("userId").references(() => users.id, { onDelete"cascade" }),
+  clerkId: text("clerkId"),
  attribute: text("attribute").default("customer"),
});
```

#### Custom session claims

Our sessions allow for conditional expressions. This would allow you add a session claim that will return either the `externalId` (the previous id for your user) when it exists, or the `userId` from Clerk. This will result in your imported users returning their `externalId` while newer users will return the Clerk `userId`.

In your Dashboard, go to Sessions -> Edit. Add the following: 

```json
{
	"userId": "{{user.external_id || user.id}}"
}
```

You can now access this value using the following:
```ts 
const { sessionClaims } = auth();
console.log(sessionClaims.userId) 
```

You can add the following for typescript: 
```js
// types/global.d.ts

export { };

declare global {
  interface CustomJwtSessionClaims {
    userId?: string;
  }
}
```

#### Here is an example of accessing the tenet tables with the new patterns

```js
// src/app/page.tsx

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

  let userAttribute = null

  // check if userId is either next auth id or clerkid
  userAttribute = await db.query.userAttributes.findFirst({
    where: eq(userAttributes.userId, dbUser?.id!),
  });

  if(userAttribute === null) {
     userAttribute = await db.query.userAttributes.findFirst({
       where: eq(userAttributes.clerkId, dbUser?.id!),
     });
  }

  return (
    <>
      <div>Special Attribute: {userAttribute?.attribute}</div>
      <UserButton />
    </>
  );
}
```

### 7. Switch all instances of next auth with clerk after batch import rate falls below rate limit

This happens when 

Af

### 8. (Optional) Setup API point to sync data with next auth

If you setup a webhook through the clerk dashboard and configure it to send events on user.created, this will allow you to setup an endpoint that allows you to sync the signed up users in clerk to your existing nextauth backend in case of rollback.

Here is a rough overview of how it would look

```js
// need to put file path here
export default const POST(req: Request) => {
  const body = req.json();

  await db.insert(users).values({
    email: body.emailAddresses[0].emailAddress,
    name: body.first_name + body.last_name,
  })
}
```

## Overview of migration flow
<!-- I am unsure how much we should hand hold the migrator -->

1. Migrate all auth helper functions to use clerk's auth function ie clerk's auth() and/or currentUser() and/or sessionClaims.userId
2. Batch import and trickle migration
    - While this is going on, users will sign in through clerk. The sign in component has a special effect that runs that adds the user to clerk if they haven't already migrated during the batch import.
3. New users sign up with clerk components
4. Once the batch import is finished and all users are imported into clerk, you can delete the sign in script, it's api points, and the batch import api point

## Wrapping Up
With your users now imported into Clerk and your application updated, you can fully switch to using Clerk for authentication. This guide provides a comprehensive approach to migrating from Next-Auth to Clerk with minimal disruption to