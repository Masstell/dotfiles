---
description: Check a planned config change against how this homelab is managed
argument-hint: "<what you want to change>"
---
Before changing anything for this: $@

Config on these machines comes from Ansible (run from /root/ansible on the Proxmox host), and anything Ansible manages is overwritten on its next run. So:
1. Find out whether the file or setting involved is Ansible-managed. Signs: an "Ansible managed" header, a matching template or task in the ansible repo if it is in this project, or files under /etc, systemd units, docker compose stacks and dotfiles placed by a role.
2. If it is managed, do not edit it in place. Write up the change as it should go into the role: which role, file or template, and the exact diff.
3. If it is not managed, say so, and say how you checked, before making the change.
4. Never touch data under /mnt/raid beyond reading it.
