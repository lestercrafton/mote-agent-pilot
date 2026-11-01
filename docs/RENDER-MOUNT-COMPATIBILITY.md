# Render mount compatibility candidate — 0.7.3-render-mount.1

**Historical candidate notes:** R1 A corrections and current release gates are documented in [RECOVERY-R1-A.md](RECOVERY-R1-A.md); that document supersedes the pre-R1 implementation details below.

This is a prepared custody compatibility change, not an authorization to activate a service, transfer a key, change permissions, or submit a transaction. The frozen v0.7.2 source, native helper, original launch controller, payer and journals remain unchanged.

The native Render service's observed persistent mount is `/var/data`, root-owned, GID 1000, mode 02775. The original importer correctly refuses a generally group-writable ancestor. Merely checking the service's own group list would be insufficient: named POSIX ACL entries and retained process/thread credentials can provide other writers.

The candidate permits this one mount only after fresh, bounded checks establish the narrower root-and-service-UID boundary. All ordinary ancestor checks remain unchanged. No path substitution, chmod, chown, root capability, package installation, credential, or alternative secret destination is introduced.

## Required evidence

- The existing Render identity, source-commit, configuration, role-separation and activation checks must pass first. The native path still requires Linux and refuses the test runner environment.
- `/var/data` must be a canonical directory owned by UID 0, with GID equal to the nonroot service's primary GID and exact full mode 02775. `/`, `/var`, `/etc`, `/usr`, `/usr/bin`, `/usr/lib` and `/proc` must remain canonical, root-owned and not group/other writable.
- Root-owned, single-link, canonical, mode-0644 `/etc/passwd`, `/etc/group` and `/etc/nsswitch.conf` are read through no-follow descriptors with fixed buffers of at most 65537 bytes. Device, inode, owner, group, mode, link count, size and nanosecond change/modify timestamps must match before/open/after reading and again at the end. Duplicate/malformed account records, another primary/explicit member, unknown members, or non-files passwd/group/initgroups name service are refused.
- Real/effective UID/GID and all four `/proc/self/status` UID/GID fields must agree. Supplementary groups contain only the primary GID. The caller must have zero effective/permitted capabilities and `NoNewPrivs=1`.
- Every visible PID and task/TID is examined twice, with stable lists and credential fields. Limits are 4096 PIDs, 1024 tasks per PID, 4096 total tasks and 16384 bytes per status file. An inaccessible/racing/unknown process refuses the operation. A nonroot/nonservice identity carrying the mount group, or any effective/permitted capability, refuses it.
- The already-installed `/usr/bin/python3` must resolve to the canonical, root-owned, mode-0755, single-link `/usr/bin/python3.11`. That canonical executable is invoked directly, never through a shell, with `-I -S`, a fixed program, a minimal environment, a two-second timeout and a 4096-byte output bound. The existing provider-controlled Python runtime and standard library are trusted like the existing Node runtime; no new runtime is installed or downloaded. Other versions/locations refuse rather than silently selecting a fallback.
- The isolated Python program opens `/var/data` with `O_DIRECTORY|O_NOFOLLOW`. It queries only `system.posix_acl_access` and `system.posix_acl_default` on that descriptor. **Only ENODATA for both is accepted.** Present attributes, EOPNOTSUPP, EACCES, other errors or malformed output refuse. Its pre/post descriptor metadata must agree and match the JavaScript mount snapshot. Executable and mount checks repeat after the probe. This relies on trusted ordinary Linux POSIX-ACL/VFS/LSM semantics; a provider that masks ACL errors as ENODATA is outside the supported environment.

Mode bits alone do not establish ACL absence: group bits may represent the ACL mask. See [Linux ACL semantics](https://man7.org/linux/man-pages/man5/acl.5.html) and [kernel POSIX ACL implementation](https://github.com/torvalds/linux/blob/master/fs/posix_acl.c). Generic xattr errors must not be treated as absence.

## Preserved custody behavior and limitations

The secret destination remains `/var/data/mote-sepolia-quote/quote.key`. The service-owned private directory retains access bits 0700; the setgid mount can cause inherited full mode 02700, which does not grant group access. Secret and journal files retain mode 0600. Symlink refusal, no-follow opens, inode checks, exclusive creation, no-overwrite intent/challenge/receipt handling, fsync, uncertainty retention and buffer clearing remain in place. Ancestor/membership/ACL/credential checks repeat at reservation, challenge, key commit, inspection and before startup reads.

These observations are **not an atomic attestation of all future writers**. The existing trust boundary includes the provider/kernel/container root and all code running as the same service UID. Those principals can already read/replace the key and can delegate authority later. The checks cannot protect against malicious trusted root/same-UID code, writers outside the visible PID namespace granted access by the provider, a compromised system runtime/kernel, or complete disk rollback. Rechecks detect observed changes; they do not eliminate all TOCTOU races against trusted principals. The provider must continue to attach this disk only to the approved service instance.

Strict process-list stability can reject harmless process churn. Any failure after a durable import reservation retains that reservation; it never permits an automatic new import. Run the complete read-only checker against the actual host before starting the one-time import. Current host metadata/xattr observations alone are not a successful execution of the complete checker.

## Source binding and handoff

A new hosted source revision needs an independent review, exact public commit and complete source-manifest verification. The quote-key handoff descriptor and its destination hash must bind the **actual new hosted commit**, service ID, origin, unchanged chain configuration hash and original Q address. Do not present old commit `5053415643cc24565b2a3bf3d77ad5d518ba9ac6` as the hash of changed hosted files.

The original controller and payer must not be restarted, replaced or repinned. Its immutable bootstrap source commitment and `public-config-pins.json.sourceCommit` remain historical bootstrap provenance. Preserve those files and all chain configuration bytes. Record the newly reviewed hosted commit/manifest and handoff descriptor separately in activation evidence. The old controller's `check_host` verifies service/chain identity, not current hosted source commit; therefore independently verify the actual Render commit and source manifest before import and after restart. No token contract, payment behavior, nonce, fee cap, recipient, signer or transaction-manifest change is part of this candidate.

The complete native read-only probe and source-binding review remain release gates. Tests below use public fixtures and local EVM only; they do not demonstrate live secret transfer.
