# Creator studio components

The web studio uses the dark palette in `styles/design-tokens.css`. Use the lime accent for actions, focus and selected navigation. Reserve the warning and danger colors for status and keep the accompanying text visible.

- `components/app-shell.tsx` provides the sidebar, mobile navigation dialog, workspace actions and skip link.
- `components/ui/primitives.tsx` provides Button, Card, Badge, form fields and alerts.
- `components/ui/studio.tsx` provides the native Modal, EmptyState, Skeleton, Toast and vertical VideoPlayer. Use retained run artifacts for video and artwork.
- `components/ui/tabs.tsx` provides route navigation with `aria-current`. Every view has a shareable URL.
- `features/timeline/progress-stream.tsx` shows the current VideoRun state and recorded step attempts. Keep the state order aligned with the existing contract.

Use visible field labels and text labels for status. For an icon alongside a visible label, hide the icon from assistive technology. Keep retryable errors visible and announce the result of actions with a status message.
