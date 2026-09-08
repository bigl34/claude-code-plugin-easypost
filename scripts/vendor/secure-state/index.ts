export {
  acquireSecureStateLock,
  releaseSecureStateLock,
  secureReadJson,
  secureStateDir,
  secureStatePath,
  secureWrite,
  secureWriteJsonAtomic,
  withSecureStateLock,
} from "./secure-state.js";
export type { SecureStateLock, SecureStateLockOptions } from "./secure-state.js";

