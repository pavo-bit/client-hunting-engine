import { redirect } from "next/navigation";
import { requireOperatorPage } from "@/lib/auth/guard";

export default async function Home() {
  await requireOperatorPage("/");
  redirect("/agencies");
}
