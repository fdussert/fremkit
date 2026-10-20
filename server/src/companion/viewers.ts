/**
 * Whether anyone on this Mac can see a pairing request right now: the code and the browser's name
 * show in two places only, the dashboard's prompt (the `companion` channel) and the request card
 * of Settings → Devices in the admin. A request nobody can see is refused (`POST
 * /api/companion/pair`, 409 `unseen`), so a program guessing codes cannot do it unseen.
 *
 * Both signals come from callers that hold the access secret, which the pairing route itself does
 * not ask for: a process that cannot read the secret cannot pass for a viewer. Only this Mac's
 * pages count. A paired device never hears the `companion` channel, and its socket is not a
 * dashboard of this Mac's.
 */

/**
 * How long after the Devices pane's last poll it still counts as open. The pane polls every 3 s
 * (`DEVICES_POLL_MS` in `ui/src/admin/devices.ts`); three periods ride out two late or lost polls,
 * and a pane closed (or a tab the browser stopped running timers in) stops counting within 9 s.
 * A request lives two minutes, so the pane has to be open when it comes, not just once before.
 */
export const PANE_POLL_WINDOW_MS = 9_000

export class PairingViewers {
  private lastPanePoll = -Infinity

  /**
   * @param dashboards How many of this Mac's dashboards are subscribed to `companion` (`Hub`).
   */
  constructor(
    private readonly dashboards: () => number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The Devices pane asked for the status while open (`GET /api/devices?watch=1`). */
  notePanePoll(): void {
    this.lastPanePoll = this.now()
  }

  /** True when a request would show somewhere on this Mac now. */
  seen(): boolean {
    return this.dashboards() > 0 || this.now() - this.lastPanePoll <= PANE_POLL_WINDOW_MS
  }
}
