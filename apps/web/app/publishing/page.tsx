import { AutomationCalendar } from "../../features/publishing/automation-calendar";
import { Calendar } from "../../features/publishing/calendar";
export default function PublishingPage(): React.JSX.Element {
  return (
    <>
      <AutomationCalendar />
      <Calendar />
    </>
  );
}
