"use client";
import { Button } from "./ui";

/** A submit button that asks "are you sure?" before the form is sent. */
export function ConfirmButton({ message, children, tone }: { message: string; children: React.ReactNode; tone?: "default" | "primary" | "danger" | "good" }) {
  return (
    <Button tone={tone} onClick={(e) => { if (!window.confirm(message)) e.preventDefault(); }}>
      {children}
    </Button>
  );
}
