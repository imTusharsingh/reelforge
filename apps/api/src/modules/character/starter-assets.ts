import type { AssetMediaType } from "../asset/asset.types.js";

/**
 * Project-authored starter artwork. These are deterministic placeholder PNGs
 * created for ReelForge and released under CC0-1.0. They are embedded in code
 * rather than downloaded at runtime, so creating a starter character performs a
 * real local storage write of known bytes and never calls an external provider.
 */
export type StarterAssetDefinition = Readonly<{
  key: string;
  filename: string;
  mediaType: AssetMediaType;
  base64: string;
  rightsHolder: string;
  licenseType: string;
  licenseTerms: string;
}>;

const RIGHTS = {
  rightsHolder: "ReelForge project authors",
  licenseType: "CC0-1.0",
  licenseTerms: "Dedicated to the public domain under CC0 1.0 Universal.",
} as const;

export const STARTER_ASSETS: Readonly<Record<string, StarterAssetDefinition>> = {
  "starter-nova": {
    key: "starter-nova",
    filename: "starter-nova.png",
    mediaType: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAACeElEQVR42u3d0VHFMAxE0S2DGqiJb6qgSSqCFnjE0q7kO+N/oj1OhpfYst7e3hnGISIAAAAGAAAwAACAAQAADAAAyBo/359PBgCG0Adh6IbckyV0Ve6BEro2+hAGXR69nUFE72UQ0XsZRPpeAxG9l0Gk7zXQ9PTb/sowgJD68xmUnP7uS6oCCH/mpl2eosq78BW3Qqoa9zokDmDu+0jvlctYw4JPEYMBdnyGiwDY9J22vxY1X/GIlQqdRYn0vaX1AYxbsZMO0J/+18fP38cUA+Wn/1LuxyWqKy0HcOV+UCIOoGH6H0//iUFpvUqbEUXRP2QIApiefppBFUBs9E8Y/ABFs8CS/j8MKsqXfQoY068zKAGo8Len/6rB8RBkxA9Jv8gAgF0Au9M3GngAAtN/ySAUYPT0r7gJjgFcMv0tN0E3QHj6fzeIA9gx/Y/fBADMB7jt+dP8FBLT33sTAHANwKD0zz6FAAAAAAAAAAAAAAAoAdj3I+DsTwHuAB5BAAAAAAAAAAAAABcD8D0AgL0AfBMuBGBVBMtSAGBl3JqliawNZXX0wNXR7A/YtkGDHTLsEWOTHgDsEx62T5id8uad8vSK8PeKoFvKmHY19AuiY9bSjln0jPMD0DVxUttK+obSOXdj51x6R89r3k33dM4PWHd+ACdo+E/Q4AwZTlHiFKUHBXCOGCfpbTlJ73lJnCUZURunqUYUyXnCKQVzonYQA2fKhxrMTb8DYLpBdTia8p/fvui7AWYZtGWiWb8/N0VvA4hlsOSgoS/CFkQfAWBnsNceAdAvkVNyFkC1RGCloQATX3GvBdg9AAAAAAYAADAAAIABAACM5vELyhkb5WBDq7MAAAAASUVORK5CYII=",
    ...RIGHTS,
  },
  "starter-atlas": {
    key: "starter-atlas",
    filename: "starter-atlas.png",
    mediaType: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAADAElEQVR42u3dwU3DQBCF4VcER445UAZlUQTlUAKFcUBCEYHEib2775950pwjdj7i2G/stZ6eX1ILS2lBAAKQCkAAUgEIQCoAAUgFIACpAAQgFYAAEOr18yMAK7t/ens/vb0HYE33fwC4BkJ3/xwAaiB0938BEA2E7v4lAM5A6O7/CcAyELr7/wGADITu/hUAioHQ3b8OgDAQuvs3AfwNhO7+FgBzA6G7vxHA2UDo7m8HsDUQuvt3AXgaCN39ewEMDYTu/gMAbvMDuXX/gYY+ABaA2/n+UAAfA7kdeaYBmBjI7bg/E8DBQG6/upMBlhvI7ZxnPsBaA7mdcS4BWGggt/P9VQCrDOR2tbUQYImB3K511wLMN5Bb0rAcYLKB3HIeB4CZBrLqvg/ANANZdd8KYI6BrLrvBjDBQFbdNwQYPT/Q6O4bNtRqfqDR//s1AMYZaPSRpwzAIAONPu5XAhhhoNG/usUADjfQ6HOeegDHGqhqvk+ZH6hwvo+YH6h2vu8/P1D5fN98fqAO+b7z/EBN8n3b+YH65Pue8wO1yvcN5wfqlu+7zQ/UMN+3mh+oZ77vMz+4+xsQgJufP/w3IABXatJZUAAO6f6u64AA7O/+3ivhAOzs/gFZUAB23rdyQBraHMBiHtAWwGgi1hDAbibcCsD0rogmANb3BZUHANwZVxgAc29oSQDY3dHFAPJ8QJ4PGJyb1sj3HZ8Ra5Xvmz4l2Sff931OuEm+b/2kfId8332viPL5PmC3lNr5PmO/oML5PmbHrKr5PmnPuJL5PmzXxHr5Pm/f0GL5PnLn3Er5PnXv6DL5Pnj39Br5ft4fkPcH2M8P8gaNlfMDt8WavkWJm+8XARgxP/BcpvWb9Ij5fimAo+YHzgsEvE2Vle8XBNgzP/BfGuaN2pR8vyzAvfMDyqJIANvnB6AVwQC2zA9Yy+EBXJ8f4NaCBPhvfkBcCBXgcn4AXQUY4Hx+wF0CG+D7e4D++/EA9ApAAAKQCkAAUgEIQCoAAUgFIACpAAQgNam+APYM8PeSyZtrAAAAAElFTkSuQmCC",
    ...RIGHTS,
  },
};

export function starterAssetDefinition(key: string): StarterAssetDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(STARTER_ASSETS, key)
    ? STARTER_ASSETS[key]
    : undefined;
}

export function starterAssetBody(definition: StarterAssetDefinition): Buffer {
  const body = Buffer.from(definition.base64, "base64");
  if (body.length === 0) throw new Error(`Starter asset ${definition.key} has no bytes`);
  return body;
}
