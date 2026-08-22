#!/bin/sh
set -e
iptables -N FIRENET-FWD 2>/dev/null || true
while iptables -C FORWARD -j FIRENET-FWD 2>/dev/null; do iptables -D FORWARD -j FIRENET-FWD; done
iptables -I FORWARD -j FIRENET-FWD
iptables -F FIRENET-FWD
iptables -A FIRENET-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FIRENET-FWD -p icmp -m comment --comment "allow-icmp" -j ACCEPT
iptables -A FIRENET-FWD -j DROP
