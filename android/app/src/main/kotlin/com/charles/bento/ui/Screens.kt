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
    @Composable fun notes(modifier: Modifier, nav: NavController) = Placeholder("Notes", modifier)
    @Composable fun todo(modifier: Modifier, nav: NavController, action: MutableStateFlow<HomeAction?>) = Placeholder("Todo", modifier)
    @Composable fun voice(modifier: Modifier, nav: NavController) = Placeholder("Voice", modifier)
    @Composable fun noteEditor(id: String, nav: NavController) = Placeholder("Note $id")
    @Composable fun trash(nav: NavController) = Placeholder("Recently Deleted")
    @Composable fun meeting(id: String, nav: NavController) = Placeholder("Meeting $id")
    @Composable fun dictionary(nav: NavController) = Placeholder("Dictionary")
    @Composable fun modes(nav: NavController) = Placeholder("Modes")
}

@Composable
private fun Placeholder(title: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(title) }
}
