import { register } from '@antv/x6-vue-shape'
import FlowNode from './FlowNode.vue'

let registered = false

export function registerFlowNode() {
  if (registered) return
  register({
    shape: 'hbh-node',
    width: 220,
    height: 62,
    component: FlowNode,
  })
  registered = true
}
