export function useRouter(): { push: (href: string) => void } {
  return { push: (href: string): void => window.location.assign(href) };
}

export function usePathname(): string {
  return window.location.pathname;
}
