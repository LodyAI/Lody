package app.lody.android.home

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import app.lody.android.R
import app.lody.android.designsystem.*

/** Absent = keep, null = remove, including an empty string = an explicit replacement. */
internal fun validEnvironmentKey(key: String) = key.matches(Regex("[A-Za-z_][A-Za-z0-9_]*")) && key.length <= 128

/** Credentials are supplied only by the user; existing values never enter this component. */
@Composable
internal fun ProviderEnvironment(existingKeys: List<String>, patch: Map<String, String?>, enabled: Boolean, onChange: (Map<String, String?>) -> Unit) {
    var newKey by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
        Text(stringResource(R.string.settings_agent_env), style = LodyTheme.typography.body)
        Text(stringResource(R.string.settings_agent_env_hint), style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary)
        (existingKeys + patch.keys).distinct().sorted().forEach { key ->
            Column {
                Text(key, style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary)
                if (patch.containsKey(key) && patch[key] != null) {
                    OutlinedTextField(patch[key].orEmpty(), { onChange(patch + (key to it)) },
                        enabled = enabled, modifier = Modifier.fillMaxWidth(), singleLine = true,
                        label = { Text(stringResource(R.string.settings_agent_env_value)) },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false))
                } else Text(stringResource(if (patch.containsKey(key)) R.string.settings_agent_env_removed else R.string.settings_agent_env_kept), style = LodyTheme.typography.footnote)
                Row {
                    if (!patch.containsKey(key) || patch[key] == null) TextButton(enabled = enabled, onClick = { onChange(patch + (key to "")) }) { Text(stringResource(R.string.settings_agent_env_replace)) }
                    if (!patch.containsKey(key) || patch[key] != null) TextButton(enabled = enabled, onClick = { onChange(if (key in existingKeys) patch + (key to null) else patch - key) }) { Text(stringResource(R.string.settings_agent_remove)) }
                    if (key in existingKeys && patch.containsKey(key)) TextButton(enabled = enabled, onClick = { onChange(patch - key) }) { Text(stringResource(R.string.settings_agent_env_keep)) }
                }
            }
        }
        OutlinedTextField(newKey, { newKey = it }, enabled = enabled, singleLine = true,
            label = { Text(stringResource(R.string.settings_agent_env_key)) }, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false))
        TextButton(enabled = enabled && validEnvironmentKey(newKey) && newKey !in existingKeys && newKey !in patch, onClick = {
            onChange(patch + (newKey to "")); newKey = ""
        }) { Text(stringResource(R.string.settings_agent_env_add)) }
    }
}
