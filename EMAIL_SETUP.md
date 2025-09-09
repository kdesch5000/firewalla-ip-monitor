# Email Notification Setup

The Firewalla IP Monitor now supports email notifications for database cleanup operations using the system's mail command.

## Configuration

Email settings are configured in `webapp/server.js` at lines 52-61. The current configuration sends emails to `admin@example.com` using the system mail command.

## System Mail Setup

The application uses the system's `mail` command, which should already be configured on your system. No additional SMTP configuration is required.

### Verify Mail Command Works
Test that the mail command is working:

```bash
echo "Test message" | mail -s "Test Subject" admin@example.com
```

If this works, the email notifications will work automatically.

## Email Notifications

Emails are sent when:
- Database cleanup occurs (age-based, size-based, or geolocation cleanup)
- At least one record is deleted during cleanup
- Email notifications are enabled (default: true)

The email includes:
- Summary of records deleted
- Database size before/after cleanup
- Space reclaimed
- Cleanup reasons and configuration details

## Testing

To test email notifications:
1. Manually trigger retention policies via API:
```bash
curl -X POST http://localhost:3001/api/retention/run
```
2. Check your email for the cleanup report

## Troubleshooting

- Check service logs: `sudo journalctl -u firewalla-monitor -f`
- Test system mail command: `echo "test" | mail -s "test" admin@example.com`
- Verify mail system is configured on the host

## Disabling Email Notifications

To disable email notifications, set `enableEmailNotifications: false` in the database configuration in `server.js`.