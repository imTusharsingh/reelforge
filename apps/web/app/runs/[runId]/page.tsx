"use client";
import type { JSX } from "react";
import { useParams } from "next/navigation";
import { AuthWorkspace } from "../../../components/auth-workspace";
import { RunScreen } from "../../../features/timeline/run-screen";
export default function Page(): JSX.Element {
  const { runId } = useParams<{ runId: string }>();
  return (
    <AuthWorkspace>
      <RunScreen key={runId} id={runId} />
    </AuthWorkspace>
  );
}
