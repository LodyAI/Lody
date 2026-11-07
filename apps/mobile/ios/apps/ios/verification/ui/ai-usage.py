"""Usage stat tiles, chart selection, token/cost metric, unavailable and stale states, and late-range fencing."""
import json,sys
from driver import UI
import catalog
from settings_states import has_notice, no_header_refresh, notice, pull, spoken, tap, try_again, unavailable
ui=UI(sys.argv[1],sys.argv[2])
def period(key):ui.axe('tap','--label',catalog.text('settings.aiUsage.'+key),'--post-delay','.2')
def tile(key,value):
    label=catalog.text(key)
    ui.wait(lambda items:any(item.get('AXLabel')==label and str(item.get('AXValue'))==value for item in items),f'Usage tile {label} missing {value}')
def header():return str(ui.element('list-visual-bars-header').get('AXValue',''))
unavailable(ui,'settings.unavailable.usage');ui.capture('usage-unavailable');try_again(ui)
tile('settings.aiUsage.tokens','12,500');tile('settings.aiUsage.costShort',catalog.text('settings.aiUsage.unavailable'))
notice(ui,'settings.aiUsage.partialShort')
no_header_refresh(ui)
assert '02:00' in header() and '6K' in header(),'Chart summary does not name the peak bucket: '+header()
ui.capture('usage-chart')
chart=ui.element('list-visual-bars')['frame']
ui.axe('tap','-x',str(chart['x']+chart['width']*0.85),'-y',str(chart['y']+chart['height']*0.5),'--post-delay','.5')
ui.wait(lambda items:'05:00' in header(),'Selecting a bar did not update the chart header')
ui.capture('usage-chart-selected')
ui.axe('tap','-x',str(chart['x']+chart['width']*0.85),'-y',str(chart['y']+chart['height']*0.5),'--post-delay','.5')
ui.wait(lambda items:'02:00' in header(),'Tapping the selected bar again did not clear the selection: '+header())
pull(ui,'list-visual-bars-header',has_notice)
notice(ui);tile('settings.aiUsage.tokens','12,500');ui.capture('usage-cached-offline');tap(ui,'list-notice-action')
period('week');ui.element('usage-week-pending');period('month')
ui.element('usage-late-settled');tile('settings.aiUsage.tokens','400,000');tile('settings.aiUsage.costShort','$1.25')
ui.capture('usage-current-range')
ui.axe('tap','--label',catalog.text('settings.aiUsage.costMetric'),'--post-delay','.5')
ui.wait(lambda items:'$1.25' in header(),'Cost metric did not switch the chart: '+header())
ui.capture('usage-cost-metric')
period('total');tile('settings.aiUsage.tokens','0');tile('settings.aiUsage.costShort','$0.00');ui.capture('usage-real-zero')
print(json.dumps({'unknownNotZero':True,'timelineTotals':True,'chartSelection':True,'costMetric':True,'cachedOffline':True,'lateRangeIgnored':True,'trueZero':True}))
