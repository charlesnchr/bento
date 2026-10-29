package com.charles.bento.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.navigation.NavController
import kotlinx.coroutines.flow.MutableStateFlow

/** The app's screens, by route (filled in module by module). */
object Screens {
    @Composable fun notes(modifier: Modifier, nav: NavController) = com.charles.bento.ui.notes.NotesScreen(modifier, nav)
    @Composable fun todo(modifier: Modifier, nav: NavController, action: MutableStateFlow<HomeAction?>) = com.charles.bento.ui.todo.TodoScreen(modifier, nav, action)
    @Composable fun voice(modifier: Modifier, nav: NavController) = com.charles.bento.ui.voice.VoiceScreen(modifier, nav)
    @Composable fun assistant(modifier: Modifier, nav: NavController, action: MutableStateFlow<HomeAction?>) = com.charles.bento.ui.assistant.AssistantScreen(modifier, nav, action)
    @Composable fun noteEditor(id: String, nav: NavController) = com.charles.bento.ui.notes.NoteEditorScreen(id, nav)
    @Composable fun trash(nav: NavController) = com.charles.bento.ui.notes.TrashScreen(nav)
    @Composable fun meeting(id: String, nav: NavController) = com.charles.bento.ui.voice.MeetingScreen(id, nav)
    @Composable fun dictionary(nav: NavController) = com.charles.bento.ui.settings.DictionaryScreen(nav)
    @Composable fun modes(nav: NavController) = com.charles.bento.ui.settings.ModesScreen(nav)
}

@Composable
private fun Placeholder(title: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(title) }
}
