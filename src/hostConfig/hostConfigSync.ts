import type { DiffEntry, FieldChange } from "../diffReport/diffReport.types";
import { SECRET_MASK } from "../diffReport/redactSecrets";
import { getEnvs } from "../env";
import type { InputConfigArrInstance } from "../types/config.types";
import { ConfigValidationError } from "../validation";

export type HostConfig = NonNullable<InputConfigArrInstance["host_config"]>;

/**
 * The host settings Configarr knows how to manage. Apps expose a subset; a declared
 * field is applied only when the live host resource returns it.
 */
export type HostResource = {
  id?: number;
  authenticationMethod?: string;
  authenticationRequired?: string;
  allowedHosts?: string | null;
  oidcAuthority?: string | null;
  oidcClientId?: string | null;
  oidcUserIdentifier?: string | null;
  oidcScopes?: string | null;
  oidcClientSecret?: string | null;
  enableSsl?: boolean;
  sslCertPath?: string | null;
  sslKeyPath?: string | null;
  whisparrAutoMatchOnDate?: boolean;
  whisparrCorruptFileDetection?: boolean;
  backupFolder?: string | null;
  backupInterval?: number;
  backupRetention?: number;
  logLevel?: string | null;
  analyticsEnabled?: boolean;
  instanceName?: string | null;
  launchBrowser?: boolean;
  certificateValidation?: string;
  updateAutomatically?: boolean;
  updateMechanism?: string;
  branch?: string | null;
  urlBase?: string | null;
  username?: string | null;
  password?: string | null;
  passwordConfirmation?: string | null;
  oidcAllowedEmails?: string | null;
  oidcAllowedEmailDomains?: string | null;
  oidcRequireEmailVerified?: boolean;
  oidcAllowAnyVerifiedUser?: boolean;
};

export type HostClient = {
  getHostConfig(): Promise<HostResource>;
  updateHostConfig(id: string, data: HostResource): Promise<void>;
};

type HostFields = Record<string, keyof HostResource>;

/** Fields every supported *arr exposes: general settings, local credentials, backup and TLS base. */
const standardFields = {
  authenticationMethod: "authenticationMethod",
  authenticationRequired: "authenticationRequired",
  allowedHosts: "allowedHosts",
  enableSsl: "enableSsl",
  sslCertPath: "sslCertPath",
  sslKeyPath: "sslKeyPath",
  whisparrAutoMatchOnDate: "whisparrAutoMatchOnDate",
  whisparrCorruptFileDetection: "whisparrCorruptFileDetection",
  backup_folder: "backupFolder",
  backup_interval: "backupInterval",
  backup_retention: "backupRetention",
  log_level: "logLevel",
  analytics_enabled: "analyticsEnabled",
  instance_name: "instanceName",
  launch_browser: "launchBrowser",
  certificate_validation: "certificateValidation",
  update_automatically: "updateAutomatically",
  update_mechanism: "updateMechanism",
  branch: "branch",
  url_base: "urlBase",
  local_username: "username",
  local_password: "password",
} as const satisfies HostFields;

/** Fields for apps with federated authentication (Radarr v7, Sonarr v5, Whisparr v3). */
const federatedFields = {
  oidcAuthority: "oidcAuthority",
  oidcClientId: "oidcClientId",
  oidcUserIdentifier: "oidcUserIdentifier",
  oidcScopes: "oidcScopes",
  oidcClientSecret: "oidcClientSecret",
} as const satisfies HostFields;

/** Fields the Chaptarr fork adds on top of Readarr. */
const chaptarrFields = {
  oidc_allowed_emails: "oidcAllowedEmails",
  oidc_allowed_email_domains: "oidcAllowedEmailDomains",
  oidc_require_email_verified: "oidcRequireEmailVerified",
  oidc_allow_any_verified_user: "oidcAllowAnyVerifiedUser",
} as const satisfies HostFields;

const secretKeys = new Set(["oidcClientSecret", "local_password"]);
const controlKeys = new Set(["update_oidc_client_secret", "rotate_local_password"]);

const authenticationMethods = new Set(["none", "basic", "forms", "external"]);
const authenticationRequirements = new Set(["enabled", "disabledForLocalAddresses", "disabledForLocalhost"]);

type SyncOptions = {
  appLabel: string;
  fields: HostFields;
  rotateOidcSecret?: boolean;
  rotateLocalPassword?: boolean;
};

/**
 * Apply the declared host settings. Every declared field must be part of the app's
 * field group and must be returned by the live resource; otherwise the run is rejected
 * with the field named and nothing is written.
 */
export async function syncHostConfig(client: HostClient, config: HostConfig, options: SyncOptions): Promise<DiffEntry[]> {
  const current = await client.getHostConfig();
  const changes: FieldChange[] = [];
  const unsupported: string[] = [];
  let next: HostResource = { ...current };

  for (const [configKey, apiField] of Object.entries(options.fields) as Array<[keyof HostConfig, keyof HostResource]>) {
    if (secretKeys.has(configKey)) continue;
    const value = config[configKey];
    if (value === undefined) continue;
    if (!Object.hasOwn(current, apiField)) {
      unsupported.push(configKey);
      continue;
    }
    if (value !== current[apiField]) {
      changes.push({ field: apiField, from: current[apiField], to: value });
      next = { ...next, [apiField]: value };
    }
  }

  if ("oidcClientSecret" in options.fields && config.oidcClientSecret !== undefined) {
    if (!Object.hasOwn(current, "oidcClientSecret")) {
      unsupported.push("oidcClientSecret");
    } else if (
      options.rotateOidcSecret ||
      (current.oidcClientSecret !== SECRET_MASK && current.oidcClientSecret !== config.oidcClientSecret)
    ) {
      changes.push({ field: "oidcClientSecret", from: SECRET_MASK, to: SECRET_MASK });
      next = { ...next, oidcClientSecret: config.oidcClientSecret };
    }
  }

  if ("local_password" in options.fields && config.local_password !== undefined) {
    if (!Object.hasOwn(current, "password")) {
      unsupported.push("local_password");
    } else if (options.rotateLocalPassword || current.password == null || current.password === "") {
      // The API never returns the password, only null/empty or a mask. Compare presence,
      // then use the same explicit rotation semantics as oidcClientSecret.
      changes.push({ field: "password", from: SECRET_MASK, to: SECRET_MASK });
      next = { ...next, password: config.local_password, passwordConfirmation: config.local_password };
    }
  }

  if (unsupported.length) {
    throw new ConfigValidationError(`${options.appLabel} host configuration does not expose ${unsupported.join(", ")}`);
  }

  if (!changes.length) return [];
  if (current.id == null) throw new Error("Host settings are missing an id");
  if (!getEnvs().DRY_RUN) await client.updateHostConfig(String(current.id), next);
  return [{ resourceType: "HostConfig", name: "General", action: "update", fieldChanges: changes }];
}

export class HostConfigSync {
  constructor(
    private readonly client: HostClient,
    private readonly appLabel: string,
  ) {}

  protected fields(): HostFields {
    return standardFields;
  }

  private assertSupported(config: HostConfig): void {
    const supported = new Set(Object.keys(this.fields()));
    const declared = Object.keys(config) as Array<keyof HostConfig>;
    const unsupported = declared.filter((key) => !supported.has(key) && !controlKeys.has(key));
    if (unsupported.length) {
      throw new ConfigValidationError(`${this.appLabel} host configuration does not expose ${unsupported.join(", ")}`);
    }
  }

  validate(config: HostConfig, _version?: string | null): void {
    if (config.oidcClientSecret === SECRET_MASK) throw new ConfigValidationError("oidcClientSecret cannot be the masked placeholder");
    if (config.update_oidc_client_secret && !("oidcClientSecret" in this.fields())) {
      throw new ConfigValidationError(`${this.appLabel} host configuration does not expose oidcClientSecret`);
    }
    if (config.update_oidc_client_secret && config.oidcClientSecret === undefined) {
      throw new ConfigValidationError("update_oidc_client_secret requires oidcClientSecret");
    }
    if (config.local_password === SECRET_MASK) throw new ConfigValidationError("local_password cannot be the masked placeholder");
    if (config.rotate_local_password && config.local_password === undefined) {
      throw new ConfigValidationError("rotate_local_password requires local_password");
    }
    if (config.authenticationMethod !== undefined && !authenticationMethods.has(config.authenticationMethod)) {
      throw new ConfigValidationError(`Unsupported authenticationMethod '${config.authenticationMethod}'`);
    }
    if (config.authenticationRequired !== undefined && !authenticationRequirements.has(config.authenticationRequired)) {
      throw new ConfigValidationError(`Unsupported authenticationRequired '${config.authenticationRequired}'`);
    }
    this.assertSupported(config);
  }

  sync(config: HostConfig): Promise<DiffEntry[]> {
    this.assertSupported(config);
    return syncHostConfig(this.client, config, {
      appLabel: this.appLabel,
      fields: this.fields(),
      rotateOidcSecret: config.update_oidc_client_secret,
      rotateLocalPassword: config.rotate_local_password,
    });
  }
}

/** Host settings for apps with federated authentication. */
export class FederatedHostConfigSync extends HostConfigSync {
  protected override fields(): HostFields {
    return { ...super.fields(), ...federatedFields };
  }
}

/** Host settings for the Chaptarr fork, which adds its own OIDC fields on top of Readarr. */
export class ChaptarrHostConfigSync extends FederatedHostConfigSync {
  protected override fields(): HostFields {
    return { ...super.fields(), ...chaptarrFields };
  }
}
