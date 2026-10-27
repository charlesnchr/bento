package com.charles.bento.voice

import android.content.Context
import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.voicesync.DictionaryEntry
import com.charles.bento.core.voicesync.VoiceDictionary
import com.charles.bento.core.voicesync.VoiceMode
import com.charles.bento.core.voicesync.VoiceSettings
import com.charles.bento.core.voicesync.VoiceStore
import com.charles.bento.core.voicesync.isEntry
import com.charles.bento.core.voicesync.isMode
import com.charles.bento.core.voicesync.VOICE_SETTINGS_ID
import com.charles.bento.core.voicesync.voiceCollectionSync
import com.charles.bento.data.FieldDocStore
import com.charles.bento.settings.Prefs
import com.charles.bento.sync.SyncHub
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.withContext

/**
 * The `voice` collection: the dictionary, the cleanup instructions and dictation modes,
 * shared with the Macs (docs/SYNC_PROTOCOL.md, "Voice documents").
 */
class VoiceSyncModule(context: Context, prefs: Prefs, private val hub: SyncHub, private val engine: CoroutineDispatcher) {
    val repo = FieldDocStore(context, "voice.db")
    val sync = voiceCollectionSync(repo)
    val connection = hub.register(sync)
    val store = VoiceStore(repo, device = { prefs.deviceName.value }, onLocalChange = { hub.localChange(sync.collection) })

    val docs = repo.docs

    suspend fun <T> perform(block: VoiceStore.() -> T): T = withContext(engine) { store.block() }

    companion object {
        /** The dictionary as listed (one per term, starred first, newest first), from a snapshot. */
        fun dictionary(docs: List<FieldDoc>): List<DictionaryEntry> =
            VoiceDictionary.deduplicated(docs.filter { it.isEntry }.map(DictionaryEntry::of)).sortedWith(VoiceDictionary.order)

        fun modes(docs: List<FieldDoc>): List<VoiceMode> = docs.filter { it.isMode }.map(VoiceMode::of).sortedBy { it.order }

        fun settings(docs: List<FieldDoc>): VoiceSettings = VoiceSettings.of(docs.firstOrNull { it.id == VOICE_SETTINGS_ID && !it.deleted })
    }
}
