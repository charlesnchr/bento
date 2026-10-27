package com.charles.bento.todo

import android.content.Context
import android.text.format.DateFormat
import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.todo.DateText
import com.charles.bento.core.todo.TodoActions
import com.charles.bento.core.todo.TodoDates
import com.charles.bento.core.todo.todoCollectionSync
import com.charles.bento.data.FieldDocStore
import com.charles.bento.settings.Prefs
import com.charles.bento.sync.SyncHub
import com.charles.bento.widget.Widgets
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The Todo module: tasks and projects in `todos.db`, synced as the `todos` collection,
 * changed through the same [TodoActions] the Mac uses (ported), on the engine thread.
 */
class TodoModule(private val context: Context, prefs: Prefs, private val hub: SyncHub, private val engine: CoroutineDispatcher) {
    val store = FieldDocStore(context, "todos.db")
    val sync = todoCollectionSync(store)
    val connection = hub.register(sync)
    val actions = TodoActions(
        store,
        device = { prefs.deviceName.value },
        dates = ::dates,
        onLocalChange = {
            hub.localChange(sync.collection)
            Widgets.refresh(context)
        },
    )

    /** Every task and project (incl. tombstones) as of the last change. */
    val docs: StateFlow<List<FieldDoc>> = store.docs

    init {
        store.onChange = { _, remote -> if (remote) Widgets.refresh(context) }
    }

    /** Today in this time zone, with the phone's own date formats (ICU skeletons, like the Mac). */
    fun dates(): TodoDates = TodoDates(format = icuDates)

    /** Runs on the engine thread (every change to documents happens there). */
    suspend fun <T> perform(block: TodoActions.() -> T): T = withContext(engine) { actions.block() }

    companion object {
        private val formatters = HashMap<String, DateTimeFormatter>()

        val icuDates = DateText { skeleton, value ->
            val locale = Locale.getDefault()
            val f = synchronized(formatters) {
                formatters.getOrPut("${locale.toLanguageTag()}|$skeleton") {
                    DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, skeleton), locale)
                }
            }
            f.format(value)
        }
    }
}
