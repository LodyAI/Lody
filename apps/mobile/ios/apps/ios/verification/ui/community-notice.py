"""The first-use community notice is a system alert with Star and Not Now."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def has_notice(items):
    labels = [item.get('AXLabel') or '' for item in items]
    return (
        catalog.text('communityNotice.title') in labels
        and any(catalog.text('communityNotice.message') in label for label in labels)
        and catalog.text('communityNotice.star') in labels
        and catalog.text('communityNotice.later') in labels
    )


def notice_gone(items):
    return catalog.text('communityNotice.title') not in (item.get('AXLabel') or '' for item in items)


ui.wait(has_notice, 'Missing community notice after opening the offline entry')
ui.capture('alert')

ui.axe('tap', '--label', catalog.text('communityNotice.later'), '--post-delay', '.8')
ui.wait(notice_gone, 'Community notice stayed after Not Now')

ui.open_case('community-notice')
ui.wait(has_notice, 'offline entry must show the community notice again')
ui.capture('again')

ui.axe('tap', '--label', catalog.text('communityNotice.later'), '--post-delay', '.8')
ui.wait(notice_gone, 'Community notice stayed after the second dismiss')
print('Community notice shows unofficial-project copy, Star and Not Now, and the offline entry can show it again.')
