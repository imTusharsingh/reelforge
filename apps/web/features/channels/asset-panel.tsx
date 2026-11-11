"use client";
import { useState, type FormEvent, type JSX } from "react";
import { Alert, Button, Field, Panel, SelectField } from "../../components/ui/primitives";
import { segment } from "./api";
import { canEdit } from "./model";
import { SelectedRead } from "./content-panels";
import { failure, Picker, RecordList, ResourceState, useChannelsClient, useResource } from "./ui";
import { assetTypes, validateAsset } from "./asset-validation";
export function AssetPanel(): JSX.Element {
  const client = useChannelsClient();
  const [rev, setRev] = useState(0);
  const assets = useResource("assets", true, "asset", rev);
  const [chosen, setChosen] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [holder, setHolder] = useState("");
  const [license, setLicense] = useState("");
  const [terms, setTerms] = useState("");
  const [attested, setAttested] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("new");
  const upload = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canEdit(client.role) || busy) return;
    setError("");
    setNotice("");
    try {
      if (!file) throw new Error("Choose a file.");
      validateAsset(file, holder, license, attested);
      if (mode === "version" && !chosen)
        throw new Error("Select an asset before uploading a version.");
      setBusy(true);
      const bytes = new Uint8Array(await file.arrayBuffer());
      client.signal.throwIfAborted();
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await client.request(mode === "version" ? `assets/${segment(chosen)}/versions` : "assets", {
        method: "POST",
        shape: "asset",
        body: {
          contentBase64: btoa(binary),
          mediaType: file.type,
          filename: file.name,
          rights: {
            ownership: "USER_UPLOADED",
            rightsHolder: holder.trim(),
            licenseType: license.trim(),
            licenseTerms: terms.trim(),
            rightsAttested: attested,
          },
        },
      });
      if (!client.signal.aborted) {
        setNotice("Asset saved with its rights metadata.");
        setRev((v) => v + 1);
        setAttested(false);
      }
    } catch (e) {
      if (!client.signal.aborted) setError(failure(e));
    } finally {
      if (!client.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="rf-channel-stack">
      <Panel>
        <h2>Workspace assets</h2>
        <p>
          Versioned media with documented rights. No preview URL is exposed by this API; object keys
          are not public links.
        </p>
        <Button tone="ghost" onClick={() => setRev((v) => v + 1)}>
          Refresh assets
        </Button>
        <ResourceState {...assets} empty={!assets.data.length} />
        <RecordList items={assets.data} />
        <Picker label="Inspect asset" items={assets.data} value={chosen} onChange={setChosen} />
      </Panel>
      {chosen && (
        <>
          <SelectedRead
            key={`${chosen}-versions`}
            title="Asset versions"
            path={`assets/${segment(chosen)}/versions`}
            shape="asset"
          />
          <SelectedRead
            key={`${chosen}-usage`}
            title="Asset usage"
            path={`assets/${segment(chosen)}/usage`}
          />
        </>
      )}
      <Panel>
        <h3>Upload licensed media</h3>
        <form className="rf-detail-form" onSubmit={(e) => void upload(e)}>
          <fieldset className="rf-channel-fields" disabled={!canEdit(client.role) || busy}>
            <legend className="rf-sr-only">Media and rights</legend>
            <SelectField
              id="asset-mode"
              label="Upload destination"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="new">New asset</option>
              <option value="version">New version of selected asset</option>
            </SelectField>
            <Field
              id="asset-file"
              label="Media file"
              type="file"
              accept={assetTypes.join(",")}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <Field
              id="asset-holder"
              label="Rights holder"
              value={holder}
              onChange={(e) => setHolder(e.target.value)}
              required
            />
            <Field
              id="asset-license"
              label="License type"
              value={license}
              onChange={(e) => setLicense(e.target.value)}
              required
            />
            <Field
              id="asset-terms"
              label="License terms"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
            />
            <label>
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
              />{" "}
              I attest that I have documented rights to use this media.
            </label>
          </fieldset>
          {error && (
            <Alert tone="danger" title="Upload failed">
              {error}
            </Alert>
          )}
          {notice && <p role="status">{notice}</p>}
          <Button type="submit" loading={busy} disabled={!canEdit(client.role)}>
            Upload asset
          </Button>
        </form>
      </Panel>
    </div>
  );
}
