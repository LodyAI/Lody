"""An explicit Role machine survives native insertion and send-time expansion in both hosts."""
import sys
from driver import UI
ui=UI(*sys.argv[1:])
field='create-session-input' if 'role-mention-sheet' in str(ui.output) else 'session-input'
ui.element(field)
ui.axe('tap','--id',field,'--post-delay','.4')
ui.axe('tap','--id','session-mention','--post-delay','.3')
ui.axe('type','multi')
ui.element('mention-item:role-multi@m2')
ui.capture('role-target-autocomplete')
ui.axe('tap','--id','mention-item:role-multi@m2','--post-delay','.5')
ui.wait(lambda items:any(item.get('AXUniqueId')==field and item.get('AXValue')=='@role:role-multi@m2 ' for item in items),'Role target was lost in native input')
ui.capture('role-target-inserted')
ui.axe('tap','--id','session-send','--post-delay','.6')
ui.wait(lambda items:any('agent role[id: role-multi, agentRoleMachineId: m2, name: Multi reviewer]' in str(item.get('AXLabel','')) for item in items),'Explicit machine did not reach the native transcript')
ui.capture('role-target-expanded')
print('PASS: role ID and explicit machine survive native selection and expansion')
