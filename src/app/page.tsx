import { redirect } from "next/navigation";

// The app's root sends people to the dashboard; the proxy bounces
// unauthenticated visitors to /login.
export default function Home() {
  redirect("/dashboard");
}
