"use client";

import { useCallback, useEffect, useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import {
  Alert,
  Badge,
  Button,
  Field,
  Panel,
  SelectField,
  TextAreaField,
} from "../../components/ui/primitives";
import {
  browserTimeZone,
  describeGates,
  formatDuration,
  isEditableRole,
  type Channel,
  type CreatePostRequest,
  type Disclosure,
  type EligibleRender,
  type Platform,
  type PlatformAvailability,
  type Post,
  type Privacy,
  type Preflight,
  type SocialAccount,
} from "./model";
import { usePublishingClient } from "./session";

type Step = "compose" | "preflight" | "done";
type Delivery = "publish-now" | "schedule";

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function Composer(): JSX.Element {
  const workspace = useActiveWorkspace();
  if (!isEditableRole(workspace.role))
    return (
      <section>
        <header className="rf-page-heading">
          <p className="rf-eyebrow">Studio / Publishing</p>
          <h1>Publishing composer</h1>
        </header>
        <Alert tone="warning" title="Read-only">
          An owner or editor can compose and schedule posts. Viewer access cannot create deliveries.
        </Alert>
        <Panel>
          <StudioLink href="/publishing">Return to the publishing calendar</StudioLink>
        </Panel>
      </section>
    );
  return <ComposerForm />;
}

function ComposerForm(): JSX.Element {
  const api = usePublishingClient();
  const timezone = browserTimeZone();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [platforms, setPlatforms] = useState<PlatformAvailability[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [renders, setRenders] = useState<EligibleRender[]>([]);
  const [renderCursor, setRenderCursor] = useState<string | null>(null);
  const [rendersLoading, setRendersLoading] = useState(false);

  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState<Step>("compose");
  const [created, setCreated] = useState<Post | null>(null);
  const [preflights, setPreflights] = useState<Preflight[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<CreatePostRequest | null>(null);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const [recoveryConflict, setRecoveryConflict] = useState(false);

  const [channelId, setChannelId] = useState("");
  const [renderJobId, setRenderJobId] = useState("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [privacy, setPrivacy] = useState<Privacy>("private");
  const [madeForKids, setMadeForKids] = useState(false);
  const [caption, setCaption] = useState("");
  const [decision, setDecision] = useState<Disclosure["decision"]>("NOT_REQUIRED");
  const [disclosureText, setDisclosureText] = useState("");
  const [disclosureReason, setDisclosureReason] = useState("");
  const [delivery, setDelivery] = useState<Delivery>("schedule");
  const [scheduleLocal, setScheduleLocal] = useState(() =>
    localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)),
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    void Promise.all([api.platforms(), api.accounts(), api.channels(), api.eligibleRenders()])
      .then(([nextPlatforms, nextAccounts, nextChannels, page]) => {
        if (!active) return;
        setPlatforms(nextPlatforms);
        setAccounts(nextAccounts);
        setChannels(nextChannels.filter((channel) => channel.status !== "ARCHIVED"));
        setRenders(page.items);
        setRenderCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active)
          setLoadError(cause instanceof Error ? cause.message : "Unable to load composer.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    const saved = api.pendingCreate();
    if (saved) setRecovery(saved);
    else if (api.hasPendingCreate()) setRecoveryUnavailable(true);
  }, [api]);

  const render = renders.find((item) => item.renderJobId === renderJobId) ?? null;
  const channelAccounts = accounts.filter((account) => account.channelId === channelId);
  const selectedAccounts = channelAccounts.filter((account) =>
    selectedAccountIds.includes(account.id),
  );
  const selectedPlatforms = [...new Set(selectedAccounts.map((account) => account.platform))];
  const platformStatus = (value: Platform): PlatformAvailability | undefined =>
    platforms.find((item) => item.platform === value);

  const selectRender = (value: string): void => {
    setRenderJobId(value);
    const next = renders.find((item) => item.renderJobId === value);
    if (next) {
      setChannelId(next.channelId);
      setSelectedAccountIds([]);
      if (!titleTouched) setTitle(next.title.slice(0, 100));
    }
  };

  const loadMoreRenders = async (): Promise<void> => {
    if (renderCursor === null || rendersLoading) return;
    setRendersLoading(true);
    setError("");
    try {
      const page = await api.eligibleRenders(undefined, renderCursor);
      setRenders((current) => [
        ...current,
        ...page.items.filter(
          (item) => !current.some((existing) => existing.renderJobId === item.renderJobId),
        ),
      ]);
      setRenderCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approved renders could not be loaded.");
    } finally {
      setRendersLoading(false);
    }
  };

  const buildRequest = (): CreatePostRequest | null => {
    if (!render) {
      setError("Select an approved render.");
      return null;
    }
    if (selectedAccounts.length === 0) {
      setError("Select at least one connected destination account.");
      return null;
    }
    const disclosure: Disclosure =
      decision === "DISCLOSE"
        ? {
            decision: "DISCLOSE",
            disclosureText: disclosureText.trim(),
            reason: disclosureReason.trim(),
          }
        : { decision: "NOT_REQUIRED", reason: disclosureReason.trim() };
    if (disclosure.reason.length === 0) {
      setError("Explain the disclosure decision.");
      return null;
    }
    if (disclosure.decision === "DISCLOSE" && disclosure.disclosureText.length === 0) {
      setError("Enter the disclosure text that must appear in the published description.");
      return null;
    }
    let scheduledAt: string | null = null;
    if (delivery === "schedule") {
      const date = new Date(scheduleLocal);
      if (!Number.isFinite(date.getTime())) {
        setError("Enter a valid schedule date and time.");
        return null;
      }
      if (date.getTime() <= Date.now()) {
        setError("The scheduled time must be in the future.");
        return null;
      }
      scheduledAt = date.toISOString();
    }
    const destinations: CreatePostRequest["destinations"] = [];
    for (const account of selectedAccounts) {
      if (account.platform === "YOUTUBE") {
        const cleanTitle = title.trim();
        if (cleanTitle.length === 0 || cleanTitle.length > 100) {
          setError("The YouTube title must be between 1 and 100 characters.");
          return null;
        }
        const cleanTags = parseTags(tags);
        if (cleanTags.some((tag) => tag.length > 500)) {
          setError("Each YouTube tag must be 500 characters or fewer.");
          return null;
        }
        let descriptionValue = description;
        if (
          disclosure.decision === "DISCLOSE" &&
          !descriptionValue.includes(disclosure.disclosureText)
        ) {
          descriptionValue = `${descriptionValue}${descriptionValue.trim() ? "\n\n" : ""}${disclosure.disclosureText}`;
        }
        if (descriptionValue.length > 5000) {
          setError("The YouTube description is too long once the disclosure text is included.");
          return null;
        }
        destinations.push({
          platform: "YOUTUBE",
          socialAccountId: account.id,
          metadata: {
            platform: "YOUTUBE",
            title: cleanTitle,
            description: descriptionValue,
            ...(cleanTags.length === 0 ? {} : { tags: cleanTags }),
            privacyStatus: privacy,
            selfDeclaredMadeForKids: madeForKids,
          },
        });
      } else if (account.platform === "INSTAGRAM") {
        if (caption.length > 2200) {
          setError("The Instagram caption must be 2200 characters or fewer.");
          return null;
        }
        destinations.push({
          platform: "INSTAGRAM",
          socialAccountId: account.id,
          metadata: { platform: "INSTAGRAM", caption },
        });
      }
    }
    return {
      clientRequestId,
      channelId,
      renderJobId: render.renderJobId,
      qualityReviewRunId: render.qualityReviewRunId,
      scheduledAt,
      disclosure,
      destinations,
    };
  };

  const loadPreflights = useCallback(
    async (post: Post): Promise<void> => {
      const checks = await Promise.all(
        post.destinations.map((destination) => api.preflight(destination.id)),
      );
      setCreated(post);
      setPreflights(checks);
      setStep("preflight");
    },
    [api],
  );

  const submit = async (): Promise<void> => {
    if (busy) return;
    setError("");
    setNotice("");
    const request = buildRequest();
    if (!request) return;
    setBusy(true);
    try {
      const post = await api.createPost(request);
      await loadPreflights(post);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The post could not be created.");
      const saved = api.pendingCreate();
      if (saved) setRecovery(saved);
      else if (api.hasPendingCreate()) setRecoveryUnavailable(true);
    } finally {
      setBusy(false);
    }
  };

  const recover = async (): Promise<void> => {
    if (!recovery || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const post = await api.recoverCreate(recovery);
      setRecovery(null);
      setRecoveryConflict(false);
      await loadPreflights(post);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The saved request could not be resumed.");
      if (cause instanceof Error && "status" in cause && cause.status === 409) {
        setRecoveryConflict(true);
        setRecovery(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const discardRecovery = (): void => {
    if (recovery) api.discardCreate(recovery.clientRequestId);
    setRecovery(null);
    setRecoveryUnavailable(false);
    setRecoveryConflict(false);
    setClientRequestId(crypto.randomUUID());
    setNotice("Recovery cleared after checking drafts and the calendar.");
  };

  const publish = async (): Promise<void> => {
    if (!created || busy) return;
    setBusy(true);
    setError("");
    try {
      let current = created;
      for (const destination of created.destinations) {
        current = await api.publishNow(created.id, destination.id);
      }
      setCreated(current);
      setStep("done");
      setNotice("Publish requests were accepted and delivery state was recorded.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Publishing did not complete. Refresh the saved post before another action.",
      );
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async (): Promise<void> => {
    if (!created || busy) return;
    setBusy(true);
    setError("");
    try {
      const post = await api.reconcilePost(created.id);
      api.acknowledge(`post:${created.id}`);
      setCreated(post);
      setNotice("Refreshed the persisted publishing state.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The saved post could not be loaded.");
    } finally {
      setBusy(false);
    }
  };

  const reset = (): void => {
    setCreated(null);
    setPreflights([]);
    setStep("compose");
    setNotice("");
    setError("");
    setRecovery(null);
    setClientRequestId(crypto.randomUUID());
    setRenderJobId("");
    setSelectedAccountIds([]);
    setTitle("");
    setTitleTouched(false);
    setDescription("");
    setTags("");
    setCaption("");
    setDecision("NOT_REQUIRED");
    setDisclosureText("");
    setDisclosureReason("");
  };

  const timezonePreview =
    delivery === "schedule" && Number.isFinite(new Date(scheduleLocal).getTime())
      ? new Date(scheduleLocal).toISOString()
      : null;

  if (loading)
    return (
      <section>
        <header className="rf-page-heading">
          <p className="rf-eyebrow">Studio / Publishing</p>
          <h1>Publishing composer</h1>
        </header>
        <Panel>
          <p role="status">Loading approved renders, accounts and platform capabilities…</p>
        </Panel>
      </section>
    );

  return (
    <section>
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Publishing</p>
        <h1>Publishing composer</h1>
        <p>Only approved renders for this workspace are available. Times use {timezone}.</p>
        <StudioLink href="/publishing">Calendar</StudioLink>
        {" · "}
        <StudioLink href="/publishing/accounts">Social accounts</StudioLink>
      </header>
      {loadError && (
        <Alert tone="danger" title="Composer unavailable">
          {loadError}
        </Alert>
      )}
      {error && (
        <Alert tone="danger" title="Publishing action failed">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" title="Publishing state">
          {notice}
        </Alert>
      )}
      {recovery && (
        <Alert tone="warning" title="An earlier creation may have been saved">
          The browser recorded an interrupted post creation. Retry the exact saved request so the
          server can replay it instead of creating a duplicate.
          <div className="rf-action-row">
            <Button loading={busy} onClick={() => void recover()}>
              Retry saved creation
            </Button>
            <Button tone="secondary" disabled={busy} onClick={discardRecovery}>
              I checked drafts and the calendar
            </Button>
          </div>
        </Alert>
      )}
      {recoveryUnavailable && (
        <Alert tone="warning" title="Interrupted creation recorded">
          Recovery details are unavailable. Check the calendar and drafts before composing again.
          <div className="rf-action-row">
            <Button tone="secondary" onClick={discardRecovery}>
              I checked drafts and the calendar
            </Button>
          </div>
        </Alert>
      )}
      {recoveryConflict && (
        <Alert tone="danger" title="Saved request conflict">
          A different post already used this request identifier. Review the calendar and drafts
          before composing again.
          <div className="rf-action-row">
            <Button tone="secondary" onClick={discardRecovery}>
              Review complete
            </Button>
          </div>
        </Alert>
      )}

      {step === "compose" && (
        <>
          <Panel>
            <h2>1. Choose approved content</h2>
            <SelectField
              id="composer-render"
              label="Approved render"
              value={renderJobId}
              onChange={(event) => selectRender(event.target.value)}
            >
              <option value="">Choose an approved render</option>
              {renders.map((item) => (
                <option key={item.renderJobId} value={item.renderJobId}>
                  {item.title} · {formatDuration(item.durationMs)} · {item.reviewStatus}
                </option>
              ))}
            </SelectField>
            {renderCursor !== null && (
              <Button
                tone="secondary"
                loading={rendersLoading}
                onClick={() => void loadMoreRenders()}
              >
                Load more approved renders
              </Button>
            )}
            {render && (
              <p>
                {render.title} · {formatDuration(render.durationMs)} · approved{" "}
                {new Date(render.reviewedAt).toLocaleString()}
              </p>
            )}
            <SelectField
              id="composer-channel"
              label="Channel"
              value={channelId}
              onChange={(event) => {
                setChannelId(event.target.value);
                setSelectedAccountIds([]);
              }}
            >
              <option value="">Choose a channel</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </SelectField>
          </Panel>

          <Panel>
            <h2>2. Choose destinations</h2>
            {channelId.length === 0 ? (
              <p>Choose a channel to see its connected accounts.</p>
            ) : channelAccounts.length === 0 ? (
              <p>
                No connected accounts on this channel.{" "}
                <StudioLink href="/publishing/accounts">Connect an account</StudioLink>.
              </p>
            ) : (
              <div className="rf-action-row">
                {channelAccounts.map((account) => {
                  const availability = platformStatus(account.platform);
                  return (
                    <label key={account.id} className="rf-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedAccountIds.includes(account.id)}
                        onChange={(event) =>
                          setSelectedAccountIds((current) =>
                            event.target.checked
                              ? [...current, account.id]
                              : current.filter((id) => id !== account.id),
                          )
                        }
                      />{" "}
                      {account.platform} · {account.displayName} · {account.status} /{" "}
                      {account.health}
                      {availability && !availability.publishable
                        ? ` · publishing unavailable (${availability.reasonCode ?? "not configured"})`
                        : ""}
                    </label>
                  );
                })}
              </div>
            )}
            {platforms.map((item) => (
              <p key={item.platform}>
                {item.platform}:{" "}
                {item.connectable ? "connection available" : "connection unavailable"}
                {item.publishable ? " · publishing available" : " · publishing unavailable"}
                {item.reasonCode ? ` (${item.reasonCode})` : ""}
              </p>
            ))}
          </Panel>

          {selectedPlatforms.includes("YOUTUBE") && (
            <Panel>
              <h2>3. YouTube metadata</h2>
              <Field
                id="composer-title"
                label="YouTube title"
                value={title}
                maxLength={100}
                onChange={(event) => {
                  setTitleTouched(true);
                  setTitle(event.target.value);
                }}
              />
              <TextAreaField
                id="composer-description"
                label="YouTube description"
                value={description}
                maxLength={5000}
                rows={5}
                onChange={(event) => setDescription(event.target.value)}
                hint="The disclosure text is appended automatically when disclosure is required."
              />
              <Field
                id="composer-tags"
                label="Tags (comma separated)"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
              />
              <SelectField
                id="composer-privacy"
                label="Privacy"
                value={privacy}
                onChange={(event) => setPrivacy(event.target.value as Privacy)}
              >
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </SelectField>
              <label className="rf-checkbox">
                <input
                  type="checkbox"
                  checked={madeForKids}
                  onChange={(event) => setMadeForKids(event.target.checked)}
                />{" "}
                Made for kids
              </label>
            </Panel>
          )}

          {selectedPlatforms.includes("INSTAGRAM") && (
            <Panel>
              <h2>Instagram metadata</h2>
              <TextAreaField
                id="composer-caption"
                label="Instagram caption"
                value={caption}
                maxLength={2200}
                rows={4}
                onChange={(event) => setCaption(event.target.value)}
              />
              <p>Instagram publishing remains fail-closed until its connector is verified.</p>
            </Panel>
          )}

          <Panel>
            <h2>4. Disclosure</h2>
            <SelectField
              id="composer-disclosure"
              label="Disclosure decision"
              value={decision}
              onChange={(event) => setDecision(event.target.value as Disclosure["decision"])}
            >
              <option value="NOT_REQUIRED">Disclosure not required</option>
              <option value="DISCLOSE">Disclose promotional material</option>
            </SelectField>
            {decision === "DISCLOSE" && (
              <Field
                id="composer-disclosure-text"
                label="Disclosure text"
                value={disclosureText}
                maxLength={1000}
                onChange={(event) => setDisclosureText(event.target.value)}
              />
            )}
            <TextAreaField
              id="composer-disclosure-reason"
              label="Disclosure reason"
              value={disclosureReason}
              maxLength={1000}
              rows={2}
              onChange={(event) => setDisclosureReason(event.target.value)}
            />
          </Panel>

          <Panel>
            <h2>5. Delivery</h2>
            <SelectField
              id="composer-delivery"
              label="Delivery"
              value={delivery}
              onChange={(event) => setDelivery(event.target.value as Delivery)}
            >
              <option value="schedule">Schedule for later</option>
              <option value="publish-now">Publish now</option>
            </SelectField>
            {delivery === "schedule" && (
              <>
                <Field
                  id="composer-schedule"
                  label={`Schedule date and time (${timezone})`}
                  type="datetime-local"
                  value={scheduleLocal}
                  onChange={(event) => setScheduleLocal(event.target.value)}
                />
                {timezonePreview && (
                  <p>
                    Stored as {timezonePreview} in {timezone}.
                  </p>
                )}
              </>
            )}
            {delivery === "publish-now" && (
              <p>
                A draft post is created first, then each destination runs the publish preflight.
                Publishing stays blocked until every gate passes.
              </p>
            )}
            <Button loading={busy} disabled={busy} onClick={() => void submit()}>
              {delivery === "schedule" ? "Create scheduled post" : "Continue to preflight"}
            </Button>
          </Panel>
        </>
      )}

      {step === "preflight" && created && (
        <>
          <Panel>
            <h2>Preflight</h2>
            <p>
              {created.destinations.length} destination
              {created.destinations.length === 1 ? "" : "s"} · post {created.id}
            </p>
            {created.status === "SCHEDULED" || created.scheduledAt !== null ? (
              <p>
                Scheduled for {new Date(created.scheduledAt ?? "").toLocaleString()} ({timezone}).
              </p>
            ) : (
              <p>
                Unscheduled draft created. Preflight gates determine whether publishing may start.
              </p>
            )}
          </Panel>
          {created.destinations.map((destination) => {
            const check = preflights.find((item) => item.destinationId === destination.id);
            return (
              <Panel key={destination.id}>
                <h2>
                  {destination.platform} · {destination.status}{" "}
                  {check && (
                    <Badge tone={check.canPublish ? "success" : "danger"}>
                      {check.canPublish ? "Ready" : "Blocked"}
                    </Badge>
                  )}
                </h2>
                {destination.lastErrorMessage && <p>{destination.lastErrorMessage}</p>}
                {check && (
                  <ul>
                    {describeGates(check.gates).map((line, index) => (
                      <li key={`${check.destinationId}-${index}`}>{line}</li>
                    ))}
                  </ul>
                )}
              </Panel>
            );
          })}
          {created.scheduledAt === null && (
            <>
              <Button
                loading={busy}
                disabled={
                  busy ||
                  preflights.length !== created.destinations.length ||
                  preflights.some((item) => !item.canPublish)
                }
                onClick={() => void publish()}
              >
                Publish now
              </Button>
              {preflights.some((item) => !item.canPublish) && (
                <p>
                  Publishing is blocked until every failed gate is resolved. Scheduled content can
                  still be reviewed from the calendar.
                </p>
              )}
            </>
          )}
          <div className="rf-action-row">
            {created.scheduledAt !== null && (
              <StudioLink href={`/publishing/posts/${encodeURIComponent(created.id)}`}>
                View scheduled post
              </StudioLink>
            )}
            <Button tone="secondary" disabled={busy} onClick={() => void reconcile()}>
              Refresh saved state
            </Button>
            <Button tone="secondary" disabled={busy} onClick={reset}>
              Compose another
            </Button>
          </div>
        </>
      )}

      {step === "done" && created && (
        <Panel>
          <h2>Delivery recorded</h2>
          <p>
            {created.status} · {created.destinations.length} destination
            {created.destinations.length === 1 ? "" : "s"}.
          </p>
          <ul>
            {created.destinations.map((destination) => (
              <li key={destination.id}>
                {destination.platform}: {destination.status}
                {destination.remotePostId ? ` · ${destination.remotePostId}` : ""}
              </li>
            ))}
          </ul>
          <StudioLink href={`/publishing/posts/${encodeURIComponent(created.id)}`}>
            Post detail
          </StudioLink>
          {" · "}
          <StudioLink href="/publishing">Calendar</StudioLink>
          <div className="rf-action-row">
            <Button tone="secondary" onClick={reset}>
              Compose another
            </Button>
          </div>
        </Panel>
      )}
    </section>
  );
}
