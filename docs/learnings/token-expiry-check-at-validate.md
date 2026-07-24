# Check token expiry during validation

## Problem

Expired tokens should stop working while remaining visible in the admin dashboard.

## Evidence

KV expiry has a 60-second floor, deletes the record, and would leave the separate `<hash>:lu` key behind. Checking the existing metadata adds no storage read and uses the current edited value.

## Decision

Store `expiresAt` as an optional UTC ISO string and check it whenever the token is validated. Reject malformed values as well as past timestamps; otherwise an invalid date could fail open. Return a distinct `token expired` response so a correctly configured client can diagnose the expected failure.

The admin converts local input to an offset-bearing UTC value before storage and localizes it for display. KV propagation remains the only delay after an edit.
