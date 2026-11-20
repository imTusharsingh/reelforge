import { StudioSettings } from "../../../features/brief/studio-settings";
import { Accounts } from "../../../features/publishing/accounts";
export default function AccountsPage(): React.JSX.Element {
  return <StudioSettings current="/publishing/accounts"><Accounts /></StudioSettings>;
}
