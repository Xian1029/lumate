import type { SVGProps } from "react";

/** Lumate's friendly learning companion, designed to stay clear at launcher size. */
export function LumateMascotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" {...props}>
      <path d="M24 11V7" stroke="#5f7968" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M24 8c-4.2-.1-6.4-2-6.8-5.2 4-.2 6.4 1.6 6.8 5.2Z" fill="#a9c8b1" />
      <path d="M24 8c4.2-.1 6.4-2 6.8-5.2-4-.2-6.4 1.6-6.8 5.2Z" fill="#d5b97d" />
      <rect x="7" y="10" width="34" height="29" rx="12" fill="#f6faf7" stroke="#66806e" strokeWidth="2.2" />
      <circle cx="18" cy="23" r="2.4" fill="#3f5045" />
      <circle cx="30" cy="23" r="2.4" fill="#3f5045" />
      <circle cx="17.2" cy="22.2" r=".7" fill="white" />
      <circle cx="29.2" cy="22.2" r=".7" fill="white" />
      <path d="M19 29.5c1.3 1.4 3 2.1 5 2.1s3.7-.7 5-2.1" stroke="#66806e" strokeWidth="2" strokeLinecap="round" />
      <path d="M11.5 36.2c4.1-1.9 8.3-1.9 12.5.1v7c-4.2-2-8.4-2-12.5-.1v-7Z" fill="#dcebe0" stroke="#66806e" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M36.5 36.2c-4.1-1.9-8.3-1.9-12.5.1v7c4.2-2 8.4-2 12.5-.1v-7Z" fill="#f2e7ca" stroke="#66806e" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}
