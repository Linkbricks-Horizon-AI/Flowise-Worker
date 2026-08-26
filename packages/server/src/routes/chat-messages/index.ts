import express from 'express'
import chatMessageController from '../../controllers/chat-messages'
import { checkAnyPermission } from '../../enterprise/rbac/PermissionCheck'
const router = express.Router()

// CREATE
// NOTE: Unused route
// router.post(['/', '/:id'], chatMessageController.createChatMessage)

// READ
router.get(
    ['/', '/:id'],
    checkAnyPermission('chatflows:view,chatflows:update,agentflows:view,agentflows:update'),
    chatMessageController.getAllChatMessages
)

// UPDATE
// [fork] no permission guard on abort: the whitelisted /api/v1/chatmessage/abort route is called by the public embed widget
router.put(['/abort/', '/abort/:chatflowid/:chatid'], chatMessageController.abortChatMessage)

// DELETE
router.delete(
    ['/', '/:id'],
    checkAnyPermission('chatflows:delete,agentflows:delete,assistants:delete'),
    chatMessageController.removeAllChatMessages
)

export default router
