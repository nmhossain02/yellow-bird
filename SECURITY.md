# Security policy

YellowBird executes browser automation today and is expected to handle
customer-authorized tools and sandboxed code in the future. Security reports
deserve a private path.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

<https://github.com/nmhossain02/yellow-bird/security/advisories/new>

Include the affected revision, impact, reproduction procedure, and any suggested
mitigation. Please do not include secrets, customer data, or exploit details in a
public issue.

## Current support

Until the project publishes a stable release, only the latest revision of the
default branch receives security fixes.

The current local scout authorizes only loopback targets. The dashboard's remote
target verification, authentication, sandboxing, and model-provider integrations
are still product stubs and must not be treated as production security controls.
