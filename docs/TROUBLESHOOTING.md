### docs/TROUBLESHOOTING.md
```markdown
# Troubleshooting Guide

## Common Issues

### "No PTP pods found"
**Cause**: PTP operator not deployed or wrong namespace
**Solution**: 
```bash
oc get pods -n openshift-ptp -l app=linuxptp-daemon
