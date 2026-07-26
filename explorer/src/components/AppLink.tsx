import type { ReactNode } from "react";

import { isPlainLeftClick, navigate } from "../lib/router.js";

export type AppLinkProps = {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
};

/** In-app anchor: real href for middle/modified clicks, SPA navigation otherwise. */
export function AppLink({ href, className, title, children }: AppLinkProps): React.JSX.Element {
  const onClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} className={className} title={title} onClick={onClick}>
      {children}
    </a>
  );
}
