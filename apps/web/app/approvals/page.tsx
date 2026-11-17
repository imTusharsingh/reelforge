import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { RunList } from "../../features/timeline/run-list";
export default function Page(): JSX.Element {
  return (
    <AuthWorkspace>
      <RunList inbox />
    </AuthWorkspace>
  );
}
