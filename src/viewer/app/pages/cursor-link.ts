// @ts-nocheck
import { createElement } from "react";
import htm from "htm";
import { parseCodeLocation } from "../services/payload";

const html = htm.bind(createElement);

function CursorLogo() {
  return html`<svg
    viewBox="0 0 32 32"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
    className="inspector-cursor-link-logo"
  >
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="m16 30l12-20v14zM4 10l12-8l12 8zm0 0l12 6v14L4 24z"
    />
  </svg>`;
}

export function renderOpenInCursorLink(
  value,
  worktreePath,
  { label = "Open in Cursor" } = {},
) {
  const codeLocation = parseCodeLocation(value ?? "", worktreePath);
  if (!codeLocation) {
    return null;
  }

  return html`<a
    className="inspector-cursor-link"
    href=${codeLocation.cursorUrl}
    aria-label=${`${label} ${codeLocation.label}`}
    title=${`${label} ${codeLocation.label}`}
  >
    <${CursorLogo} />
    <span>${label}</span>
  </a>`;
}
