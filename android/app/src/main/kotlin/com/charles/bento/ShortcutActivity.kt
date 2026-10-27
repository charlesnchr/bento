package com.charles.bento

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.charles.bento.voice.CaptureActivity

/**
 * Invisible trampoline for app shortcuts and the optional separate launcher icons
 * ("Bento Dictate", "Bento Meeting", "Bento Quick Add"), which ColorOS's Snap Key can open.
 */
class ShortcutActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val which = intent.data?.lastPathSegment ?: when (intent.component?.className?.substringAfterLast('.')) {
            "DictateLauncher" -> "thought"
            "MeetingLauncher" -> "meeting"
            "QuickAddLauncher" -> "task"
            else -> "thought"
        }
        when (which) {
            "thought" -> startActivity(CaptureActivity.intent(this, CaptureActivity.KIND_THOUGHT))
            "task" -> startActivity(CaptureActivity.intent(this, CaptureActivity.KIND_TASK))
            "meeting" -> startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_TOGGLE_MEETING)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        finish()
    }
}
