# 56. The service migrates on boot, under an advisory lock

Date: 2026-08-18

## Status

Accepted

## Context

A fresh machine with a container runtime should bring the whole system up with one command. A
service that starts, finds a schema it does not recognise and fails is not that, and a
separate migration step somebody must remember is the same problem with more documentation.

Two replicas starting together would both find an unapplied migration and both try to apply
it; one would crash-loop on a duplicate-object error during a deploy.

## Decision

`apps/api` runs the migrations at startup, holding `pg_advisory_lock(776155301)` while it
does.

## Consequences

- The checksum runner makes an edited migration a loud error but says nothing about two
  processes racing on an unapplied one; the lock covers that.
- An advisory lock is held on a connection and released when it closes, so a replica that
  dies mid-migration does not wedge the next one.
- Boot is serialised across replicas by however long the slowest migration takes, paid once
  per deploy.
